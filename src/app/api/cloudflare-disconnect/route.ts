import { NextRequest, NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/server/auth/guard';
import { promises as fs } from 'fs';
import path from 'path';
import { RouteError, errorResponse } from '@/lib/server/errors';
import {
  AlreadyRunningError,
  CERT_PATH,
  CONNECT_SCRATCH_DIR,
  CONNECT_STATE,
  CREDENTIALS_PATH,
  LOCAL_CONFIG_PATH,
  SETUP_FLOW_LOCK,
  SETUP_FLOW_LOCK_MAX_AGE_MS,
  atomicWrite,
  clearStaleFlowLocks,
  clearState,
  getConfigDir,
  killPid,
  readState,
  withFlowLock,
} from '@/lib/server/cloudflared-process';
import { teardownPreview } from '@/lib/server/preview-teardown';
import { restartAppSentence } from '@/lib/restart-copy';
import { getPlatform } from '@/lib/server/platform';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';

const ROUTE_NAME = '/api/cloudflare-disconnect';
const HOMESERVER_CONFIG = () => process.env.HOMESERVER_CONFIG_PATH || '/app/homeserver-data/config.toml';

/**
 * POST /api/cloudflare-disconnect
 * Tears down whatever Cloudflare setup exists locally - any mode - so the
 * user can start over (e.g. with a different Cloudflare account):
 *   - kills pending login / preview child processes
 *   - removes cert.pem, config.yml, credentials.json, the preview marker
 *   - truncates the tunnel token and domain files (the cloudflared
 *     containers crash-loop back to idle after the next restart)
 *   - resets icann_domain in the homeserver config to localhost so the
 *     published record stops pointing at the abandoned domain
 *
 * What it cannot do: delete the tunnel object and DNS record at Cloudflare.
 * Those need credentials we deliberately do not keep (the API token is
 * discarded after setup; the login cert is deleted). The response says so,
 * because reusing the same hostname later requires removing the old DNS
 * record in the Cloudflare dashboard first.
 */
async function handlePost(request: NextRequest) {
  const requestId = getRequestId(request);
  if (getPlatform() !== 'umbrel') {
    return errorResponse(
      new RouteError(404, 'not_supported', 'Cloudflare setup is only available on Umbrel.'),
      requestId,
    );
  }
  const startedAt = Date.now();
  const steps: Array<{ key: string; status: 'done' | 'skipped' }> = [];

  try {
    // The whole teardown runs under the setup lock: a live auto-setup or
    // connect completion would otherwise keep running past this teardown and
    // rewrite token/domain/config.yml right after they were cleared,
    // leaving the app configured again despite the disconnect. A stale lock
    // (crashed holder) is stolen by the acquisition itself.
    return await withFlowLock(SETUP_FLOW_LOCK, SETUP_FLOW_LOCK_MAX_AGE_MS, runDisconnect);
  } catch (e) {
    if (e instanceof AlreadyRunningError) {
      return errorResponse(
        new RouteError(409, 'bad_request', 'A setup flow is in progress. Wait for it to finish, then disconnect.'),
        requestId,
      );
    }
    const error = new RouteError(500, 'internal_error', 'Failed to disconnect');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(error, requestId);
  }

  // Everything below runs under the setup lock.
  async function runDisconnect(): Promise<NextResponse> {
    // Stop any child processes (pending browser-auth login via the state
    // file; the instant preview tunnel plus its marker and the wrapper
    // handshake via the shared teardown).
    const state = await readState(CONNECT_STATE());
    if (state) await killPid(state.pid, state.starttime);
    await clearState(CONNECT_STATE());
    await teardownPreview();
    // A lock orphaned by a crashed flow must not survive a "start over";
    // live locks stay (removing one would un-serialize its running flow).
    await clearStaleFlowLocks();
    steps.push({ key: 'processes', status: 'done' });

    // Remove every mode's artifacts (the scratch dir too: a cert delivered
    // there after the kill would resurrect the authorization on the next poll)
    await fs.rm(CERT_PATH(), { force: true });
    await fs.rm(CONNECT_SCRATCH_DIR(), { recursive: true, force: true });
    await fs.rm(LOCAL_CONFIG_PATH(), { force: true });
    await fs.rm(CREDENTIALS_PATH(), { force: true });
    for (const f of ['token', 'domain']) {
      try {
        await atomicWrite(path.join(getConfigDir(), f), '');
      } catch {
        // config dir may not exist in non-Umbrel environments
      }
    }
    steps.push({ key: 'credentials', status: 'done' });

    // Reset the published domain so the pkarr record stops advertising the
    // abandoned hostname after the next restart.
    try {
      const config = await fs.readFile(HOMESERVER_CONFIG(), 'utf-8');
      const reset = config
        .split('\n')
        .filter((line) => !/^public_icann_http_port\s*=/.test(line.trim()))
        .map((line) => (/^icann_domain\s*=/.test(line.trim()) ? 'icann_domain = "localhost"' : line))
        .join('\n');
      if (reset !== config) {
        const tmp = HOMESERVER_CONFIG() + '.tmp';
        await fs.writeFile(tmp, reset, 'utf-8');
        // Preserve the original file's mode across the rename (the container
        // entrypoint keeps config.toml at 0660 because it holds
        // admin_password; a default-umask tmp file would widen it to 0644).
        const prevStat = await fs.stat(HOMESERVER_CONFIG()).catch(() => null);
        if (prevStat) await fs.chmod(tmp, prevStat.mode & 0o777);
        await fs.rename(tmp, HOMESERVER_CONFIG());
      }
      steps.push({ key: 'published_domain', status: 'done' });
    } catch {
      steps.push({ key: 'published_domain', status: 'skipped' });
    }

    logRouteInfo({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      message: 'Cloudflare setup disconnected',
    });
    return NextResponse.json(
      {
        ok: true,
        steps,
        message: `Disconnected. ${restartAppSentence(getPlatform())} The tunnel and DNS record still exist in your Cloudflare account (we keep no credentials that could delete them); remove them in the Cloudflare dashboard if you want to reuse the same public address.`,
        requestId,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } // end runDisconnect
}

export const POST = withAdminAuth(handlePost);
