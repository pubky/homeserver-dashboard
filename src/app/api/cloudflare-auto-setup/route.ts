import { NextRequest, NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/server/auth/guard';
import { promises as fs } from 'fs';
import path from 'path';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { isAllowedPublicHostname } from '@/lib/server/hostname';
import {
  AlreadyRunningError,
  SETUP_FLOW_LOCK,
  SETUP_FLOW_LOCK_MAX_AGE_MS,
  TUNNEL_NAME,
  atomicWrite,
  getConfigDir,
  withFlowLock,
  writeLocallyManagedFromToken,
} from '@/lib/server/cloudflared-process';
import { detectCloudflareMode } from '@/lib/server/cloudflare-mode';
import { teardownPreview } from '@/lib/server/preview-teardown';
import {
  CfApiError,
  createDnsRecord,
  createTunnel,
  deleteDnsRecord,
  findTunnelByName,
  getTunnelToken,
  getZone,
  listDnsRecordsAtName,
  putTunnelIngress,
  updateDnsRecord,
} from '@/lib/server/cloudflare-api';
import { cfDnsRecordsUrl, cfTunnelsUrl } from '@/lib/server/cloudflare-links';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';
import { restartAppSentence } from '@/lib/restart-copy';
import { getPlatform } from '@/lib/server/platform';

const ROUTE_NAME = '/api/cloudflare-auto-setup';

/** Single DNS label: letters/digits/hyphens, no leading/trailing hyphen. */
const SUBDOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

type StepKey = 'tunnel' | 'ingress' | 'dns' | 'credentials';
type StepStatus = 'done' | 'failed';
type Step = { key: StepKey; status: StepStatus; detail?: string };

/**
 * POST /api/cloudflare-auto-setup
 * Body: { api_token: string, zone_id: string, subdomain?: string, overwrite_dns?: boolean }
 *
 * Orchestrates the full tunnel setup against the Cloudflare API:
 *   1. resolve + validate the zone (server-side; client zone names are not trusted)
 *   2. adopt-or-create the tunnel named "pubky-homeserver" (idempotent re-runs)
 *   3. PUT the ingress config (hostname -> http://homeserver:6286)
 *   4. create the proxied CNAME (409 + dns_conflict payload if a record exists,
 *      unless overwrite_dns is set)
 *   5. fetch the tunnel run token and write the same token/domain files the
 *      manual flow writes
 *
 * The API token is used for the duration of this request and discarded.
 * It is never persisted, logged, or echoed in responses.
 *
 * The response includes a `steps` array so the UI can show exactly how far
 * setup got, both on success and on failure.
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
  const steps: Step[] = [];

  const fail = (error: RouteError, logMessage?: string, extra?: Record<string, unknown>) => {
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: logMessage ?? error.message,
    });
    return NextResponse.json(
      { error: error.publicMessage, type: error.type, steps, requestId, ...extra },
      { status: error.status, headers: { 'Cache-Control': 'no-store' } },
    );
  };

  let body: { api_token?: unknown; zone_id?: unknown; subdomain?: unknown; overwrite_dns?: unknown };
  try {
    body = await request.json();
  } catch {
    return fail(new RouteError(400, 'bad_request', 'Invalid JSON payload'));
  }

  const apiToken = typeof body.api_token === 'string' ? body.api_token.trim() : '';
  const zoneId = typeof body.zone_id === 'string' ? body.zone_id.trim() : '';
  const subdomain = typeof body.subdomain === 'string' ? body.subdomain.trim().toLowerCase() : '';
  const overwriteDns = body.overwrite_dns === true;

  if (!apiToken || apiToken.length < 20 || apiToken.length > 256 || /\s/.test(apiToken)) {
    return fail(new RouteError(400, 'bad_request', 'Missing or malformed api_token'));
  }
  if (!zoneId || !/^[a-f0-9]{32}$/.test(zoneId)) {
    return fail(new RouteError(400, 'bad_request', 'Missing or malformed zone_id'));
  }
  if (subdomain && !SUBDOMAIN_PATTERN.test(subdomain)) {
    return fail(new RouteError(400, 'bad_request', 'Subdomain must be a single DNS label (letters, digits, hyphens)'));
  }

  // The whole orchestration runs under the shared setup lock: a concurrent
  // run (second tab, impatient retry) could point DNS at one tunnel while
  // the saved token runs another, a permanent 530.
  try {
    return await withFlowLock(SETUP_FLOW_LOCK, SETUP_FLOW_LOCK_MAX_AGE_MS, runSetup);
  } catch (e) {
    if (e instanceof AlreadyRunningError) {
      return fail(new RouteError(409, 'bad_request', 'Setup is already in progress'));
    }
    throw e;
  }

  // Everything below runs under the setup lock.
  async function runSetup(): Promise<NextResponse> {
    // Captured BEFORE any mutation: with a working setup at entry, the
    // running cloudflared keeps serving the OLD tunnel (it never re-reads
    // the token file) while DNS moves to the new one, so the domain stays
    // unreachable until the app restarts. From idle, the crash-looping
    // cloudflared picks the new token up within a minute.
    const { mode: priorMode } = await detectCloudflareMode();

    // --- 1. Resolve the zone server-side -------------------------------------
    let zoneName: string;
    let accountId: string;
    try {
      const zone = await getZone(apiToken, zoneId);
      if (zone.status !== 'active') {
        return fail(
          new RouteError(
            400,
            'bad_request',
            `Domain ${zone.name} is on Cloudflare but not active yet. Point its nameservers at Cloudflare first.`,
          ),
        );
      }
      zoneName = zone.name;
      accountId = zone.account.id;
    } catch (e) {
      return fail(mapCfError(e, 'zone'), e instanceof Error ? e.message : String(e));
    }

    const hostname = subdomain ? `${subdomain}.${zoneName}` : zoneName;
    if (!isAllowedPublicHostname(hostname)) {
      return fail(new RouteError(400, 'bad_request', `Resulting hostname is not valid: ${hostname}`));
    }

    // --- 2. DNS conflict gate, BEFORE any mutation -----------------------------
    // Nothing is created or modified in the user's account until this passes,
    // so cancelling at the conflict prompt has zero side effects.
    //
    // Only address-bearing records conflict with our CNAME: A, AAAA, and
    // foreign CNAMEs. MX/TXT/etc coexist with a flattened/proxied CNAME and
    // are never touched - deleting a user's apex MX records would break their
    // email. A CNAME already pointing at *.cfargotunnel.com is a previous
    // tunnel install (possibly a stale tunnel id); repointing it is the
    // expected reinstall behavior and needs no confirmation.
    let existingCname: { id: string; content: string } | undefined;
    let addressBlockers: Array<{ id: string; type: string; content: string }> = [];
    try {
      const existingRecords = await listDnsRecordsAtName(apiToken, zoneId, hostname);
      const cname = existingRecords.find((r) => r.type === 'CNAME');
      existingCname = cname ? { id: cname.id, content: cname.content } : undefined;
      addressBlockers = existingRecords
        .filter((r) => r.type === 'A' || r.type === 'AAAA')
        .map((r) => ({ id: r.id, type: r.type, content: r.content }));

      const needsConfirmation = [
        ...addressBlockers,
        ...(existingCname && !existingCname.content.endsWith('.cfargotunnel.com')
          ? [{ type: 'CNAME', content: existingCname.content }]
          : []),
      ];
      if (needsConfirmation.length > 0 && !overwriteDns) {
        steps.push({ key: 'dns', status: 'failed', detail: 'Existing DNS record at this hostname' });
        logRouteInfo({
          requestId,
          route: ROUTE_NAME,
          method: 'POST',
          statusCode: 409,
          durationMs: Date.now() - startedAt,
          message: 'DNS conflict requires user confirmation',
          meta: { recordTypes: needsConfirmation.map((r) => r.type) },
        });
        return NextResponse.json(
          {
            error: `A DNS record already exists at ${hostname}`,
            type: 'dns_conflict',
            existing_records: needsConfirmation.map((r) => ({ type: r.type, content: r.content })),
            dashboard_url: cfDnsRecordsUrl(accountId, zoneName),
            dashboard_label: `Open DNS settings for ${zoneName}`,
            steps,
            requestId,
          },
          { status: 409, headers: { 'Cache-Control': 'no-store' } },
        );
      }
    } catch (e) {
      steps.push({ key: 'dns', status: 'failed' });
      return fail(mapCfError(e, 'dns'), e instanceof Error ? e.message : String(e));
    }

    // --- 3. Adopt-or-create the tunnel ---------------------------------------
    let tunnelId: string;
    let runToken: string | undefined;
    try {
      const existing = await findTunnelByName(apiToken, accountId, TUNNEL_NAME);
      if (existing && (existing.remote_config === false || existing.config_src === 'local')) {
        // A locally-managed tunnel ignores remote ingress config; "adopting" it
        // would report success while routing nothing.
        steps.push({ key: 'tunnel', status: 'failed', detail: 'Locally-managed tunnel with the same name' });
        return fail(
          new RouteError(
            409,
            'bad_request',
            `A locally-managed tunnel named "${TUNNEL_NAME}" already exists in your Cloudflare account, and it can't be reused for this setup. Open your Cloudflare Zero Trust dashboard (Networks → Tunnels), delete or rename the "${TUNNEL_NAME}" tunnel, then run setup again.`,
          ),
          undefined,
          { dashboard_url: cfTunnelsUrl(accountId), dashboard_label: 'Open Cloudflare Tunnels' },
        );
      }
      if (existing) {
        tunnelId = existing.id;
        steps.push({ key: 'tunnel', status: 'done', detail: 'Reusing existing tunnel' });
      } else {
        const created = await createTunnel(apiToken, accountId, TUNNEL_NAME);
        tunnelId = created.id;
        runToken = created.token;
        steps.push({ key: 'tunnel', status: 'done', detail: 'Tunnel created' });
      }
    } catch (e) {
      steps.push({ key: 'tunnel', status: 'failed' });
      return fail(mapCfError(e, 'tunnel'), e instanceof Error ? e.message : String(e));
    }

    // --- 4. Ingress ------------------------------------------------------------
    try {
      await putTunnelIngress(apiToken, accountId, tunnelId, hostname);
      steps.push({ key: 'ingress', status: 'done' });
    } catch (e) {
      steps.push({ key: 'ingress', status: 'failed' });
      return fail(mapCfError(e, 'tunnel'), e instanceof Error ? e.message : String(e));
    }

    // --- 5. DNS reconcile --------------------------------------------------------
    // The conflict gate already ran; anything still here is either ours, a
    // stale tunnel CNAME (repoint), or an explicitly-confirmed overwrite.
    const target = `${tunnelId}.cfargotunnel.com`;
    try {
      // A/AAAA records only survive the gate when the user confirmed overwrite.
      for (const blocker of addressBlockers) {
        await deleteDnsRecord(apiToken, zoneId, blocker.id);
      }
      if (existingCname && existingCname.content === target) {
        steps.push({ key: 'dns', status: 'done', detail: 'DNS record already in place' });
      } else if (existingCname) {
        await updateDnsRecord(apiToken, zoneId, existingCname.id, hostname, tunnelId);
        steps.push({ key: 'dns', status: 'done', detail: 'Existing record repointed' });
      } else {
        await createDnsRecord(apiToken, zoneId, hostname, tunnelId);
        steps.push({ key: 'dns', status: 'done' });
      }
    } catch (e) {
      steps.push({ key: 'dns', status: 'failed' });
      return fail(mapCfError(e, 'dns'), e instanceof Error ? e.message : String(e));
    }

    // --- 5. Run token + files ----------------------------------------------------
    try {
      if (!runToken) {
        runToken = await getTunnelToken(apiToken, accountId, tunnelId);
      }
      // Env is read lazily via getConfigDir() (call time, not module load),
      // following the convention in cloudflared-process.ts.
      const configDir = getConfigDir();
      await fs.mkdir(configDir, { recursive: true });
      // Materialize the locally-managed files (credentials.json + config.yml)
      // from the run token, so the single cloudflared --config service runs
      // this tunnel - there is no separate token-mode container any more. The
      // `token` file below is now purely a setup-method marker (the badge) and
      // the migration source for older installs; no container reads it. The
      // entrypoint re-asserts ownership/modes at the next app start, and
      // cloudflared picks config.yml up within seconds, so the tunnel connects
      // without a restart (the restart only publishes icann_domain). Order:
      // everything the "configured" status implies must be in place before the
      // marker lands.
      await writeLocallyManagedFromToken(runToken, hostname);
      await atomicWrite(path.join(configDir, 'domain'), hostname);
      await atomicWrite(path.join(configDir, 'token'), runToken);
      // A real setup supersedes preview mode: stop publishing and serving
      // the temporary URL.
      await teardownPreview();
      steps.push({ key: 'credentials', status: 'done' });
    } catch (e) {
      steps.push({ key: 'credentials', status: 'failed' });
      // tokenToCredentials throws descriptive, secret-free messages ("Tunnel
      // token is not valid base64.", etc.) - surface those so a malformed run
      // token is debuggable instead of a blank 500.
      const error =
        e instanceof CfApiError
          ? mapCfError(e, 'tunnel')
          : e instanceof Error && e.message.startsWith('Tunnel token')
            ? new RouteError(500, 'internal_error', `Could not save the tunnel credentials: ${e.message}`)
            : new RouteError(500, 'internal_error', 'Could not save the tunnel credentials');
      return fail(error, e instanceof Error ? e.message : String(e));
    }

    logRouteInfo({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      message: 'Automatic Cloudflare setup completed',
      meta: { hostnameLength: hostname.length, adopted: steps[0]?.detail === 'Reusing existing tunnel' },
    });
    const message =
      priorMode !== 'off'
        ? `Tunnel configured. Your public address will be unreachable until the app restarts: DNS now points at the new tunnel, but the running tunnel still serves your previous setup. ${restartAppSentence(getPlatform())} The restart also publishes your public address to the Pubky network.`
        : `Tunnel configured. The tunnel connects within a minute. ${restartAppSentence(getPlatform())} The restart publishes your public address to the Pubky network.`;
    return NextResponse.json(
      {
        ok: true,
        hostname,
        steps,
        message,
        requestId,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } // end runSetup
}

/**
 * Translates CfApiError into operator-actionable messages. The `area`
 * identifies which permission would have been exercised, so a 403 can name
 * the exact missing grant instead of a generic "forbidden".
 */
function mapCfError(e: unknown, area: 'zone' | 'tunnel' | 'dns'): RouteError {
  if (!(e instanceof CfApiError)) {
    return new RouteError(502, 'upstream_error', 'Could not reach the Cloudflare API');
  }
  if (e.status === 401) {
    return new RouteError(401, 'unauthorized', 'Cloudflare rejected the token (invalid or expired).');
  }
  if (e.status === 403) {
    // Name the permission this call needed first (so the user sees the
    // immediate blocker), then list the full set so they can fix it in one
    // pass instead of one failed request at a time.
    const missing =
      area === 'dns'
        ? 'Zone > DNS > Edit'
        : area === 'tunnel'
          ? 'Account > Cloudflare Tunnel > Edit'
          : 'Zone > Zone > Read';
    return new RouteError(
      403,
      'forbidden',
      `The token is missing the "${missing}" permission. Setup needs all three: Account > Cloudflare Tunnel > Edit, Zone > DNS > Edit, and Zone > Zone > Read. Recreate the token with the pre-filled link above and try again.`,
    );
  }
  if (e.status === 404 && area === 'zone') {
    return new RouteError(400, 'bad_request', 'Domain not found for this token. Reload the domain list.');
  }
  if (e.status === 429) {
    return new RouteError(429, 'upstream_error', 'Cloudflare is rate limiting requests. Wait a minute and try again.');
  }
  return new RouteError(502, 'upstream_error', `Cloudflare API error: ${e.messages.join('; ') || `HTTP ${e.status}`}`);
}

export const POST = withAdminAuth(handlePost);
