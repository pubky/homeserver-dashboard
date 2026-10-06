import { NextRequest, NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/server/auth/guard';
import { promises as fs } from 'fs';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { isAllowedPublicHostname } from '@/lib/server/hostname';
import {
  AlreadyRunningError,
  CERT_PATH,
  getConfigDir,
  CONNECT_LOG,
  CONNECT_SCRATCH_DIR,
  CONNECT_MAX_AGE_MS,
  CONNECT_STATE,
  CONNECT_START_FLOW_LOCK,
  CONNECT_START_FLOW_LOCK_MAX_AGE_MS,
  CREDENTIALS_PATH,
  DOMAIN_PATH,
  INGRESS_SERVICE,
  LOCAL_CONFIG_PATH,
  SETUP_FLOW_LOCK,
  SETUP_FLOW_LOCK_MAX_AGE_MS,
  TOKEN_PATH,
  TUNNEL_NAME,
  atomicWrite,
  clearState,
  fileExists,
  getCloudflaredBin,
  isBinaryAvailable,
  isPidAlive,
  killPid,
  parseAuthorizedDomain,
  parseLoginUrl,
  readState,
  relocateDeliveredCert,
  runCloudflared,
  spawnDetached,
  withFlowLock,
  writeState,
} from '@/lib/server/cloudflared-process';
import { detectCloudflareMode } from '@/lib/server/cloudflare-mode';
import { cfDnsRecordsUrl, cfTunnelsUrl } from '@/lib/server/cloudflare-links';
import { teardownPreview } from '@/lib/server/preview-teardown';
import { restartAppSentence } from '@/lib/restart-copy';
import { getPlatform } from '@/lib/server/platform';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';

const ROUTE_NAME = '/api/cloudflare-connect';
const FALLBACK_TUNNEL_NAME = 'pubky-homeserver-local';
/** Where the cloudflared runtime container sees the shared config dir. */
const getRuntimeDir = () => process.env.CLOUDFLARED_RUNTIME_DIR || '/etc/cloudflared-config';

type Step = { key: 'tunnel' | 'dns' | 'config'; status: 'done' | 'failed'; detail?: string };

/**
 * "Connect Cloudflare account": browser-auth via `cloudflared tunnel login`.
 * Zero copy-paste - the user clicks the auth URL, logs in on cloudflare.com,
 * picks their domain, clicks Authorize; Cloudflare delivers cert.pem to the
 * waiting process. The cert then authorizes `tunnel create` and
 * `tunnel route dns` with no API token. The resulting tunnel is locally
 * managed (credentials.json + config.yml in the shared config dir); the
 * runtime cloudflared container runs it via --config. cert.pem is deleted
 * the moment setup completes.
 *
 * GET  -> { status: idle|waiting|authorized|completed, auth_url?, hostname?, supported }
 * POST {action:'start'}                    -> spawn login, return auth_url
 * POST {action:'complete', hostname}      -> create + route dns + write config
 * POST {action:'cancel'}                   -> abort a pending login
 */

async function currentStatus(): Promise<{
  status: 'idle' | 'waiting' | 'authorized' | 'completed';
  auth_url?: string;
  hostname?: string;
  /** Zone the cert authorizes, or null when the cert could not be parsed
   * (the client then falls back to its full-hostname input). */
  authorized_domain?: string | null;
  /** Set when idle was reached by expiring an over-age login or cert, so the
   * UI can say why the waiting card vanished instead of silently resetting. */
  expired?: boolean;
}> {
  // The login child saves the cert under $HOME/.cloudflared (HOME points at
  // the config dir); pick it up and move it to the canonical path first.
  await relocateDeliveredCert();
  const { mode, domain } = await detectCloudflareMode();
  if (mode === 'connect') {
    return { status: 'completed', hostname: domain ?? undefined };
  }
  if (await fileExists(CERT_PATH())) {
    // An unused authorization is a zone-admin credential; expire it instead
    // of letting it sit on the bind mount indefinitely.
    const certStat = await fs.stat(CERT_PATH());
    if (Date.now() - certStat.mtimeMs > CONNECT_MAX_AGE_MS) {
      await fs.rm(CERT_PATH(), { force: true });
      return { status: 'idle', expired: true };
    }
    return { status: 'authorized', authorized_domain: await parseAuthorizedDomain() };
  }
  const state = await readState(CONNECT_STATE());
  if (state) {
    const alive = isPidAlive(state.pid, state.starttime);
    const fresh = Date.now() - Date.parse(state.started_at) < CONNECT_MAX_AGE_MS;
    if (alive && fresh) {
      const url = await parseLoginUrl();
      if (url) return { status: 'waiting', auth_url: url };
      return { status: 'waiting' };
    }
    // dead or stale: clean up so the user can start fresh
    if (alive) await killPid(state.pid, state.starttime);
    await clearState(CONNECT_STATE());
    // Over-age means the authorization window lapsed; a fresh-but-dead login
    // is a crash, not an expiry, and resets silently as before.
    if (!fresh) return { status: 'idle', expired: true };
  }
  return { status: 'idle' };
}

async function handleGet(request: NextRequest) {
  const requestId = getRequestId(request);
  const status = await currentStatus();
  return NextResponse.json(
    { ...status, supported: await isBinaryAvailable(), requestId },
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

  let body: { action?: unknown; hostname?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorResponse(new RouteError(400, 'bad_request', 'Invalid JSON payload'), requestId);
  }

  if (!(await isBinaryAvailable())) {
    return errorResponse(
      new RouteError(503, 'config_error', 'cloudflared is not available in this environment'),
      requestId,
    );
  }

  // ---- cancel -----------------------------------------------------------
  if (body.action === 'cancel') {
    const state = await readState(CONNECT_STATE());
    if (state) await killPid(state.pid, state.starttime);
    await clearState(CONNECT_STATE());
    await fs.rm(CERT_PATH(), { force: true });
    await fs.rm(CONNECT_SCRATCH_DIR(), { recursive: true, force: true });
    return NextResponse.json({ status: 'idle', requestId }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // ---- start ------------------------------------------------------------
  if (body.action === 'start') {
    const existing = await currentStatus();
    if (existing.status === 'waiting' && existing.auth_url) {
      return NextResponse.json({ ...existing, requestId }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (existing.status === 'authorized' || existing.status === 'completed') {
      return NextResponse.json({ ...existing, requestId }, { headers: { 'Cache-Control': 'no-store' } });
    }
    try {
      // Spawn mutex: a concurrent start loses the lock and reports the
      // winner's state instead of spawning a second login.
      return await withFlowLock(CONNECT_START_FLOW_LOCK, CONNECT_START_FLOW_LOCK_MAX_AGE_MS, async () => {
        // Re-check under the lock: the previous holder may have spawned already.
        const current = await currentStatus();
        if (current.status !== 'idle') {
          return NextResponse.json({ ...current, requestId }, { headers: { 'Cache-Control': 'no-store' } });
        }
        // The timeout wrapper kills the login at the authorization deadline
        // even when nobody polls the status route (which is what otherwise
        // enforces CONNECT_MAX_AGE_MS). The recorded pid is the timeout
        // process; isPidAlive/killPid accept comm "timeout" for that reason.
        const child = await spawnDetached(
          ['timeout', String(CONNECT_MAX_AGE_MS / 1000), getCloudflaredBin(), 'tunnel', 'login'],
          CONNECT_LOG(),
          {
            // login saves to $HOME/.cloudflared/cert.pem; aim HOME at our dir.
            HOME: getConfigDir(),
            TUNNEL_ORIGIN_CERT: CERT_PATH(),
          },
        );
        await writeState(CONNECT_STATE(), { ...child, started_at: new Date().toISOString() });
        // The URL prints to stderr immediately (live-verified): try the parse
        // first and only sleep between retries, so the common case returns
        // without waiting. Worst case stays 20 polls over ~10 seconds.
        let url: string | null = await parseLoginUrl();
        for (let i = 0; i < 20 && !url; i++) {
          await new Promise((r) => setTimeout(r, 500));
          url = await parseLoginUrl();
        }
        if (!url) {
          await killPid(child.pid, child.starttime);
          await clearState(CONNECT_STATE());
          throw new Error('cloudflared did not produce a login URL');
        }
        logRouteInfo({
          requestId,
          route: ROUTE_NAME,
          method: 'POST',
          statusCode: 200,
          durationMs: Date.now() - startedAt,
          message: 'Connect login started',
          meta: { pid: child.pid },
        });
        return NextResponse.json(
          { status: 'waiting', auth_url: url, requestId },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      });
    } catch (e) {
      if (e instanceof AlreadyRunningError) {
        const winner = await currentStatus();
        return NextResponse.json({ ...winner, requestId }, { headers: { 'Cache-Control': 'no-store' } });
      }
      await clearState(CONNECT_STATE());
      const error = new RouteError(500, 'internal_error', 'Failed to start the Cloudflare login');
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
  }

  // ---- complete ---------------------------------------------------------
  if (body.action !== 'complete') {
    return errorResponse(
      new RouteError(400, 'bad_request', 'action must be "start", "complete" or "cancel"'),
      requestId,
    );
  }
  const hostname = typeof body.hostname === 'string' ? body.hostname.trim().toLowerCase() : '';
  const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
  const labelsValid = hostname.split('.').every((l) => LABEL.test(l));
  if (!hostname || !isAllowedPublicHostname(hostname) || !labelsValid) {
    return errorResponse(new RouteError(400, 'bad_request', 'Missing or invalid hostname'), requestId);
  }
  if (!(await fileExists(CERT_PATH()))) {
    return errorResponse(
      new RouteError(409, 'bad_request', 'Not authorized yet. Open the Cloudflare link and click Authorize first.'),
      requestId,
    );
  }
  // When the cert parses, an out-of-zone hostname can be rejected here with a
  // clear message instead of failing late inside `tunnel route dns`. A null
  // parse skips the check; route dns then remains the (late) backstop.
  const authorizedDomain = await parseAuthorizedDomain();
  if (authorizedDomain && hostname !== authorizedDomain && !hostname.endsWith(`.${authorizedDomain}`)) {
    return errorResponse(
      new RouteError(
        400,
        'bad_request',
        `${hostname} is not under the domain you authorized (${authorizedDomain}). Use a hostname ending in .${authorizedDomain}.`,
      ),
      requestId,
    );
  }

  // Completion lock: two tabs finishing simultaneously would create two
  // tunnels and leave config.yml referencing one while credentials.json
  // holds the other's secret. Shared with auto-setup and preview enable so
  // no other flow rewrites the setup artifacts mid-completion.
  try {
    return await withFlowLock(SETUP_FLOW_LOCK, SETUP_FLOW_LOCK_MAX_AGE_MS, runComplete);
  } catch (e) {
    if (e instanceof AlreadyRunningError) {
      return errorResponse(new RouteError(409, 'bad_request', 'Setup is already in progress'), requestId);
    }
    throw e;
  }

  // Everything below runs under the completion lock.
  async function runComplete(): Promise<NextResponse> {
    const steps: Step[] = [];
    const fail = (error: RouteError, logMessage: string, extra?: Record<string, unknown>) => {
      logRouteError({
        requestId,
        route: ROUTE_NAME,
        method: 'POST',
        statusCode: error.status,
        durationMs: Date.now() - startedAt,
        errorType: error.type,
        message: logMessage,
      });
      return NextResponse.json(
        { error: error.publicMessage, type: error.type, steps, requestId, ...extra },
        { status: error.status, headers: { 'Cache-Control': 'no-store' } },
      );
    };
    const certEnv = { TUNNEL_ORIGIN_CERT: CERT_PATH() };

    // 1. tunnel create, unless a previous attempt left usable credentials:
    // reusing their tunnel id keeps a retry from creating a second tunnel
    // under the fallback name and orphaning the first one in the account.
    // tunnelRef is whatever cloudflared commands should reference: the name
    // when we created the tunnel in this run, the id when reusing.
    let tunnelId: string | undefined;
    let tunnelRef = '';
    try {
      const creds = JSON.parse(await fs.readFile(CREDENTIALS_PATH(), 'utf-8')) as { TunnelID?: string };
      if (creds.TunnelID) {
        tunnelId = creds.TunnelID;
        tunnelRef = creds.TunnelID;
        steps.push({ key: 'tunnel', status: 'done', detail: 'Reusing tunnel from a previous attempt' });
      }
    } catch {
      // no usable credentials: create below
    }
    if (!tunnelId) {
      let tunnelName = TUNNEL_NAME;
      let create = await runCloudflared(
        ['tunnel', 'create', '--credentials-file', CREDENTIALS_PATH(), tunnelName],
        certEnv,
      );
      if (!create.ok && /already exists/i.test(create.output)) {
        tunnelName = FALLBACK_TUNNEL_NAME;
        create = await runCloudflared(
          ['tunnel', 'create', '--credentials-file', CREDENTIALS_PATH(), tunnelName],
          certEnv,
        );
      }
      if (!create.ok) {
        steps.push({ key: 'tunnel', status: 'failed' });
        // Both fixed names are taken: almost always leftover tunnels from
        // earlier setups. Point the user straight at the tunnels list so they
        // can delete the old "pubky-homeserver" tunnel and retry.
        const namesExhausted = /already exists/i.test(create.output);
        return fail(
          new RouteError(
            502,
            'upstream_error',
            namesExhausted
              ? `A Cloudflare tunnel named "${TUNNEL_NAME}" already exists and couldn't be reused automatically. Open your Cloudflare Zero Trust dashboard (Networks → Tunnels), delete the old "${TUNNEL_NAME}" tunnel, then run setup again.`
              : `Could not create the Cloudflare tunnel: ${lastLine(create.output)}`,
          ),
          create.output.slice(-500),
          namesExhausted
            ? { dashboard_url: cfTunnelsUrl(null), dashboard_label: 'Open Cloudflare Tunnels' }
            : undefined,
        );
      }
      steps.push({ key: 'tunnel', status: 'done', detail: tunnelName });
      tunnelRef = tunnelName;

      // The credentials file carries the tunnel id; that is our config reference.
      try {
        const creds = JSON.parse(await fs.readFile(CREDENTIALS_PATH(), 'utf-8')) as { TunnelID?: string };
        if (!creds.TunnelID) throw new Error('TunnelID missing from credentials file');
        tunnelId = creds.TunnelID;
      } catch (e) {
        steps.push({ key: 'config', status: 'failed' });
        return fail(
          new RouteError(500, 'internal_error', 'Tunnel created but its credentials file is unreadable'),
          e instanceof Error ? e.message : String(e),
        );
      }
    }

    // 2. route dns
    const route = await runCloudflared(['tunnel', 'route', 'dns', tunnelRef, hostname], certEnv);
    if (!route.ok) {
      steps.push({ key: 'dns', status: 'failed' });
      // Undo the tunnel so a retry starts clean instead of exhausting names
      // and orphaning tunnel objects in the account. When the delete itself
      // fails (network down, expired cert), the tunnel still exists at
      // Cloudflare: keep credentials.json so the next attempt reuses it
      // rather than burning one of the two fixed names.
      const del = await runCloudflared(['tunnel', 'delete', '-f', tunnelRef], certEnv);
      if (del.ok) await fs.rm(CREDENTIALS_PATH(), { force: true });
      const dnsExists = /already exists/i.test(route.output);
      const zoneNotFound = /find.*zone|zone for|no zone/i.test(route.output);
      const friendly = dnsExists
        ? `There's already a DNS record for ${hostname} in your Cloudflare account, so the tunnel can't claim that name. Either pick a different subdomain, or open your Cloudflare DNS settings, delete the existing record for ${hostname}, and run setup again.`
        : zoneNotFound
          ? `${hostname} isn't in the domain you authorized with Cloudflare${authorizedDomain ? ` (${authorizedDomain})` : ''}. Use a hostname under that domain.`
          : `Could not create the DNS record for ${hostname}: ${lastLine(route.output)}`;
      const extra = dnsExists
        ? {
            dashboard_url: cfDnsRecordsUrl(null, authorizedDomain),
            dashboard_label: authorizedDomain
              ? `Open DNS settings for ${authorizedDomain}`
              : 'Open your Cloudflare DNS settings',
          }
        : undefined;
      return fail(new RouteError(502, 'upstream_error', friendly), route.output.slice(-500), extra);
    }
    steps.push({ key: 'dns', status: 'done' });

    // 3. switch modes + write runtime config + delete the cert.
    // Write order pinned for crash safety: mode detection (here and in
    // cloudflare-config GET) treats config.yml+credentials.json as
    // "completed", and credentials.json already exists. So the token is
    // truncated first (stops the token-mode container claiming the old
    // hostname), the domain file is written next, and config.yml lands LAST:
    // a crash at any earlier point can never leave the system reporting
    // completed with a stale domain or two modes runnable at once.
    try {
      const configYml = [
        `tunnel: ${tunnelId}`,
        `credentials-file: ${getRuntimeDir()}/credentials.json`,
        'no-autoupdate: true',
        'ingress:',
        `  - hostname: ${hostname}`,
        `    service: ${INGRESS_SERVICE}`,
        '  - service: http_status:404',
        '',
      ].join('\n');
      await atomicWrite(TOKEN_PATH(), '');
      await atomicWrite(DOMAIN_PATH(), hostname);
      // World-readable until the next app start hardens them to 640+group
      // 65532 (entrypoint) - required so the crash-looping cloudflared-local
      // container can pick them up without a restart, exactly like the token
      // file in token mode. The bind mount lives inside the app-data dir.
      await fs.chmod(CREDENTIALS_PATH(), 0o644).catch(() => {});
      await atomicWrite(LOCAL_CONFIG_PATH(), configYml, 0o644);
      // The cert's job is done; it must not linger (it can create tunnels and
      // edit DNS for the authorized zone).
      await fs.rm(CERT_PATH(), { force: true });
      await clearState(CONNECT_STATE());
      // A real setup supersedes preview mode: stop publishing and serving
      // the temporary URL.
      await teardownPreview();
      steps.push({ key: 'config', status: 'done' });
    } catch (e) {
      steps.push({ key: 'config', status: 'failed' });
      return fail(
        new RouteError(500, 'internal_error', 'Could not write the tunnel configuration'),
        e instanceof Error ? e.message : String(e),
      );
    }

    logRouteInfo({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      message: 'Connect setup completed',
      meta: { hostnameLength: hostname.length, tunnel: tunnelRef },
    });
    return NextResponse.json(
      {
        ok: true,
        hostname,
        steps,
        // The crash-looping cloudflared-local container picks config.yml +
        // credentials.json up without a restart; only the pkarr publication
        // needs the restart.
        message: `Tunnel configured. The tunnel connects within a minute. ${restartAppSentence(getPlatform())} The restart publishes your public address to the Pubky network.`,
        requestId,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } // end runComplete
}

function lastLine(output: string): string {
  const lines = output.trim().split('\n').filter(Boolean);
  return lines[lines.length - 1] ?? 'unknown error';
}

export const GET = withAdminAuth(handleGet);
export const POST = withAdminAuth(handlePost);
