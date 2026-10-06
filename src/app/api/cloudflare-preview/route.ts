import { NextRequest, NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/server/auth/guard';
import { promises as fs } from 'fs';
import path from 'path';
import { RouteError, errorResponse } from '@/lib/server/errors';
import {
  AlreadyRunningError,
  PREVIEW_ENV,
  SETUP_FLOW_LOCK,
  SETUP_FLOW_LOCK_MAX_AGE_MS,
  PREVIEW_INSTANT_LOG,
  PREVIEW_INSTANT_STATE,
  clearState,
  fileExists,
  getCloudflaredBin,
  getConfigDir,
  getPreviewInstantOrigin,
  isBinaryAvailable,
  isPidAlive,
  killPid,
  parsePreviewPublishedUrl,
  parseQuickTunnelUrl,
  quickTunnelConnected,
  quickTunnelFailed,
  readState,
  spawnDetached,
  withFlowLock,
  writeState,
} from '@/lib/server/cloudflared-process';
import { detectCloudflareMode } from '@/lib/server/cloudflare-mode';
import { teardownPreview } from '@/lib/server/preview-teardown';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';
import { getPlatform } from '@/lib/server/platform';

const ROUTE_NAME = '/api/cloudflare-preview';

/**
 * Preview mode: a temporary public address (random *.trycloudflare.com,
 * no Cloudflare account, no domain) that is PUBLISHED to the Pubky network.
 *
 * Two cooperating tunnels:
 * - "instant": a child process spawned on enable, so the user has a working
 *   URL within seconds. NOT published (the homeserver already started with
 *   its old domain); dies with the container.
 * - "published": after the app restarts, the cloudflared-preview compose
 *   service (gated on the testdrive.env marker via env_file) starts before
 *   the config wrapper, which publishes its fresh URL as icann_domain.
 *   Every restart yields and publishes a new URL.
 *
 * Enable is refused while a permanent setup exists (real domain or
 * locally-managed tunnel) - preview must never shadow a real address.
 *
 * GET  -> { enabled, instant: {status,url?,error?}, published_url?, supported }
 * POST {action:'enable'}  -> marker + instant tunnel
 * POST {action:'disable'} -> kill instant tunnel + remove marker
 */

async function hasPermanentSetup(): Promise<boolean> {
  const { mode } = await detectCloudflareMode();
  return mode === 'connect' || mode === 'token';
}

async function instantStatus(): Promise<{ status: 'stopped' | 'starting' | 'running'; url?: string; error?: string }> {
  const state = await readState(PREVIEW_INSTANT_STATE());
  if (!state) return { status: 'stopped' };
  if (!isPidAlive(state.pid, state.starttime)) {
    const failed = await quickTunnelFailed();
    await clearState(PREVIEW_INSTANT_STATE());
    return failed
      ? { status: 'stopped', error: 'Cloudflare did not hand out a temporary URL. Try again in a minute.' }
      : { status: 'stopped' };
  }
  const url = await parseQuickTunnelUrl();
  const ready = Boolean(url) && (await quickTunnelConnected());
  return { status: ready ? 'running' : 'starting', url: ready ? (url ?? undefined) : undefined };
}

async function handleGet(request: NextRequest) {
  const requestId = getRequestId(request);
  const enabled = await fileExists(PREVIEW_ENV());
  const instant = await instantStatus();
  const publishedUrl = enabled ? await parsePreviewPublishedUrl() : null;
  return NextResponse.json(
    {
      enabled,
      instant,
      published_url: publishedUrl ?? undefined,
      supported: await isBinaryAvailable(),
      requestId,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}

async function handlePost(request: NextRequest) {
  const requestId = getRequestId(request);
  if (getPlatform() !== 'umbrel') {
    return errorResponse(
      new RouteError(404, 'not_supported', 'Cloudflare setup is only available on Umbrel.'),
      requestId,
    );
  }
  const startedAt = Date.now();

  let body: { action?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse(new RouteError(400, 'bad_request', 'Invalid JSON payload'), requestId);
  }

  if (body.action === 'disable') {
    // Shared teardown: kills the instant child, clears its state, removes the
    // marker AND the wrapper handshake (left behind, a later re-enable would
    // report the previous trycloudflare URL as currently published), and
    // stamps the teardown for restart detection. The flag reports whether the
    // child actually died - the response must not claim a dead tunnel while a
    // stuck child still serves it.
    const instantGone = await teardownPreview();
    logRouteInfo({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      message: instantGone ? 'Preview disabled' : 'Preview disabled but the instant tunnel did not exit',
    });
    return NextResponse.json(
      {
        enabled: false,
        instant: { status: 'stopped' },
        message: instantGone
          ? 'Preview disabled.'
          : 'Preview disabled, but the temporary tunnel process did not exit. Its URL may stay reachable until the app restarts.',
        requestId,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  }

  if (body.action !== 'enable') {
    return errorResponse(new RouteError(400, 'bad_request', 'action must be "enable" or "disable"'), requestId);
  }

  if (!(await isBinaryAvailable())) {
    return errorResponse(
      new RouteError(503, 'config_error', 'cloudflared is not available in this environment'),
      requestId,
    );
  }
  try {
    // The setup lock keeps the permanent-setup check and the marker write
    // atomic against connect complete / auto-setup: a setup completing in
    // between must not end up shadowed by preview.
    return await withFlowLock(SETUP_FLOW_LOCK, SETUP_FLOW_LOCK_MAX_AGE_MS, async () => {
      if (await hasPermanentSetup()) {
        return errorResponse(
          new RouteError(
            409,
            'bad_request',
            'A permanent Cloudflare setup already exists. Preview mode is for trying things out before setting up a real domain.',
          ),
          requestId,
        );
      }

      // Captured outside the try so the catch can kill a child that was
      // spawned before the failure.
      let spawned: { pid: number; starttime?: number } | null = null;
      try {
        // The marker gates the cloudflared-preview compose service (env_file)
        // and tells the config wrapper to publish the URL on the next start.
        // The config wrapper (root, every boot, before cloudflared-preview)
        // owns the preview dir's permissions and ownership (65532, world
        // writable). This process is nextjs (uid 1001) and does NOT own that
        // dir, so it must not chmod it - doing so throws EPERM and fails the
        // whole enable. We only ensure the dir exists; the instant tunnel logs
        // to the config-dir root (PREVIEW_INSTANT_LOG), not into preview/.
        await fs.mkdir(path.join(getConfigDir(), 'preview'), { recursive: true });
        await fs.writeFile(PREVIEW_ENV(), `TUNNEL_URL=${getPreviewInstantOrigin()}\n`, 'utf-8');

        // Instant tunnel so the user gets a working URL right away (uncapped;
        // it dies with the container and the compose service takes over after
        // the restart that actually publishes the address).
        const existing = await instantStatus();
        if (existing.status === 'stopped') {
          spawned = await spawnDetached(
            [getCloudflaredBin(), 'tunnel', '--no-autoupdate', '--url', getPreviewInstantOrigin()],
            PREVIEW_INSTANT_LOG(),
          );
          await writeState(PREVIEW_INSTANT_STATE(), { ...spawned, started_at: new Date().toISOString() });
        }
        logRouteInfo({
          requestId,
          route: ROUTE_NAME,
          method: 'POST',
          statusCode: 200,
          durationMs: Date.now() - startedAt,
          message: 'Preview enabled',
        });
        return NextResponse.json(
          { enabled: true, instant: await instantStatus(), requestId },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      } catch (e) {
        // A failed enable must leave nothing behind: a surviving marker would
        // make GET report enabled (and the next restart publish a preview
        // URL), and an unkilled child would keep an orphan tunnel serving.
        if (spawned) await killPid(spawned.pid, spawned.starttime);
        await clearState(PREVIEW_INSTANT_STATE());
        await fs.rm(PREVIEW_ENV(), { force: true });
        const error = new RouteError(500, 'internal_error', 'Failed to enable preview mode');
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
    });
  } catch (e) {
    if (e instanceof AlreadyRunningError) {
      return errorResponse(new RouteError(409, 'bad_request', 'Setup is already in progress'), requestId);
    }
    throw e;
  }
}

export const GET = withAdminAuth(handleGet);
export const POST = withAdminAuth(handlePost);
