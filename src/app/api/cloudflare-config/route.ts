import { NextRequest, NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/server/auth/guard';
import { constants as fsConstants, promises as fs } from 'fs';
import path from 'path';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { isAllowedPublicHostname } from '@/lib/server/hostname';
import { atomicWrite, fileExists, getConfigDir, writeLocallyManagedFromToken } from '@/lib/server/cloudflared-process';
import { isDecodableTunnelToken } from '@/lib/server/tunnel-credentials';
import { detectCloudflareMode } from '@/lib/server/cloudflare-mode';
import { detectRestartPending } from '@/lib/server/restart-pending';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';
import { restartAppSentence } from '@/lib/restart-copy';
import { getPlatform } from '@/lib/server/platform';

const ROUTE_NAME = '/api/cloudflare-config';
// Env is read lazily via getConfigDir() (call time, not module load),
// following the convention in cloudflared-process.ts.
const tokenFile = () => path.join(getConfigDir(), 'token');
const domainFile = () => path.join(getConfigDir(), 'domain');

// Cloudflare tunnel tokens are opaque strings but they're not arbitrary: they're long
// (>=64 chars in current formats), URL-safe, and never contain whitespace. Reject
// anything obviously malformed to catch paste errors and prevent storing junk.
const TOKEN_PATTERN = /^[A-Za-z0-9_.+/=-]+$/;
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 2048;

function isPlausibleCloudflareToken(token: string): boolean {
  if (token.length < MIN_TOKEN_LENGTH || token.length > MAX_TOKEN_LENGTH) return false;
  return TOKEN_PATTERN.test(token);
}

async function isCloudflareConfigSupported(): Promise<boolean> {
  try {
    await fs.access(getConfigDir(), fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * GET /api/cloudflare-config
 * Returns the server-derived setup mode plus the current domain (if set),
 * and the durable restart-pending signal (state mtimes vs the wrapper boot
 * stamp; null when no stamp exists and the client must fall back to its
 * in-session signals).
 * Token is never returned. `supported: false` means only one thing: the
 * config dir is not accessible in this environment (the tab is pointless);
 * any other failure is an honest 500 so the client can retry instead of
 * hiding the tab.
 */
async function handleGet(request: NextRequest) {
  const requestId = getRequestId(request);
  const startedAt = Date.now();
  const supported = await isCloudflareConfigSupported();
  try {
    const { mode, domain } = await detectCloudflareMode();
    const { restart_pending, restart_reason } = await detectRestartPending();
    const response = NextResponse.json(
      {
        domain,
        mode,
        configured: mode === 'connect' || mode === 'token',
        supported,
        restart_pending,
        restart_reason,
        requestId,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
    logRouteInfo({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      message: 'Cloudflare config read',
      meta: { mode, supported },
    });
    return response;
  } catch (e) {
    const error = new RouteError(500, 'internal_error', 'Could not read the Cloudflare configuration');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(error, requestId);
  }
}

/**
 * POST /api/cloudflare-config
 * Body: { token?: string, domain?: string }
 * Writes to mounted volume so homeserver and cloudflared pick up after restart.
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
  let body: { token?: string; domain?: string };
  try {
    body = await request.json();
  } catch {
    const error = new RouteError(400, 'bad_request', 'Invalid JSON payload');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: error.message,
    });
    return errorResponse(error, requestId);
  }

  const domain = typeof body.domain === 'string' ? body.domain.trim() : '';
  const token = typeof body.token === 'string' ? body.token.trim() : '';

  if (domain && !isAllowedPublicHostname(domain)) {
    const error = new RouteError(400, 'bad_request', 'Invalid domain');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: error.message,
      meta: { domainLength: domain.length },
    });
    return errorResponse(error, requestId);
  }

  // The token must both look plausible AND actually decode to a tunnel
  // token (base64 of {a,s,t}): we now convert it into credentials.json at
  // save time, so a mistyped/partial paste is rejected here with a clear
  // 400 instead of silently failing to produce a runnable config.
  if (token && (!isPlausibleCloudflareToken(token) || !isDecodableTunnelToken(token))) {
    const error = new RouteError(
      400,
      'bad_request',
      'That does not look like a Cloudflare tunnel token. Copy the full token from the Cloudflare dashboard.',
    );
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: error.message,
      meta: { tokenLength: token.length },
    });
    return errorResponse(error, requestId);
  }

  try {
    await fs.mkdir(getConfigDir(), { recursive: true });
  } catch (e) {
    const error = new RouteError(503, 'upstream_error', 'Config directory unavailable');
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

  // A domain-only save must land in a setup that can actually serve it.
  if (body.domain !== undefined && body.token === undefined) {
    const hasConnectConfig = await fileExists(path.join(getConfigDir(), 'config.yml'));
    const hasToken = await fs
      .readFile(tokenFile(), 'utf-8')
      .then((s) => s.trim().length > 0)
      .catch(() => false);
    // While a Connect setup exists, its tunnel keeps serving the hostname
    // baked into config.yml: writing only the domain file would make status
    // report the new domain (and the wrapper publish it) while the tunnel
    // still serves the old one.
    let error: RouteError | null = null;
    if (hasConnectConfig) {
      error = new RouteError(
        400,
        'bad_request',
        'This domain is managed by the Connect Cloudflare setup, so saving it here would not change what the tunnel serves. Disconnect first, or use the Connect flow to change domains.',
      );
    } else if (!hasToken) {
      error = new RouteError(
        400,
        'bad_request',
        'A Cloudflare tunnel token is required for the domain to work. Paste the token along with the domain, or use one of the guided setups.',
      );
    }
    if (error) {
      logRouteError({
        requestId,
        route: ROUTE_NAME,
        method: 'POST',
        statusCode: error.status,
        durationMs: Date.now() - startedAt,
        errorType: error.type,
        message: error.message,
        meta: { hasConnectConfig },
      });
      return errorResponse(error, requestId);
    }
  }

  // A token needs a hostname to serve: the locally-managed config.yml ingress
  // routes that hostname to the homeserver. Resolve it from this request or a
  // previously-saved domain; reject a token with no hostname anywhere.
  let tokenHostname = '';
  if (token) {
    tokenHostname =
      domain ||
      (await fs
        .readFile(domainFile(), 'utf-8')
        .then((s) => s.trim())
        .catch(() => ''));
    if (!tokenHostname) {
      const error = new RouteError(400, 'bad_request', 'Paste the domain together with the tunnel token.');
      logRouteError({
        requestId,
        route: ROUTE_NAME,
        method: 'POST',
        statusCode: error.status,
        durationMs: Date.now() - startedAt,
        errorType: error.type,
        message: error.message,
      });
      return errorResponse(error, requestId);
    }
  }

  try {
    if (token) {
      // Materialize credentials.json + config.yml from the token, so the
      // single cloudflared --config service runs it. The `token` file below
      // is kept only as a setup-method marker (the "API token" badge) and the
      // migration source for older installs; no container reads it.
      await writeLocallyManagedFromToken(token, tokenHostname);
    }
    if (body.domain !== undefined) {
      await atomicWrite(domainFile(), domain);
    }
    if (body.token !== undefined) {
      await atomicWrite(tokenFile(), token);
    }
    logRouteInfo({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      message: 'Cloudflare config saved',
      meta: {
        wroteDomain: body.domain !== undefined,
        wroteToken: body.token !== undefined,
      },
    });
    return NextResponse.json({
      ok: true,
      // Two separate truths: the crash-looping cloudflared picks the token up
      // by itself; only the pkarr publication needs the restart.
      message: `Saved. The tunnel picks this up within a minute. ${restartAppSentence(getPlatform())} The restart publishes your public address to the Pubky network.`,
      requestId,
    });
  } catch (e) {
    const error = new RouteError(500, 'internal_error', 'Failed to write config');
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

export const GET = withAdminAuth(handleGet);
export const POST = withAdminAuth(handlePost);
