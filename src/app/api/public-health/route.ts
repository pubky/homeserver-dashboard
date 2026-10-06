import { NextRequest, NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/server/auth/guard';
import { RouteError, errorResponse, isAbortError } from '@/lib/server/errors';
import { isAllowedPublicHostname, resolvesToPublicAddress } from '@/lib/server/hostname';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';

const CHECK_TIMEOUT_MS = 8000;
const ROUTE_NAME = '/api/public-health';

/**
 * GET /api/public-health?domain=pubky.example.com
 * Probes https://domain to see if the public URL is reachable (e.g. behind Cloudflare Tunnel).
 * Used by the dashboard to show "Public URL reachable: yes/no".
 */
async function handleGet(request: NextRequest) {
  const requestId = getRequestId(request);
  const startedAt = Date.now();
  const domain = request.nextUrl.searchParams.get('domain');
  if (!domain) {
    const error = new RouteError(400, 'bad_request', 'Missing domain');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: error.message,
    });
    return errorResponse(error, requestId);
  }
  const normalized = domain.trim().toLowerCase();
  if (!isAllowedPublicHostname(normalized)) {
    const error = new RouteError(400, 'bad_request', 'Domain not allowed');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: error.message,
      meta: { domainLength: normalized.length },
    });
    return errorResponse(error, requestId);
  }

  // SSRF defense: a public-looking hostname can still resolve to a private
  // address (10.x, 169.254.x, loopback, etc.). Resolve and reject before
  // we open an outbound connection.
  const isPublic = await resolvesToPublicAddress(normalized);
  if (!isPublic) {
    const error = new RouteError(400, 'bad_request', 'Domain does not resolve to a public address');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: error.message,
      meta: { domain: normalized },
    });
    return errorResponse(error, requestId);
  }

  const url = `https://${normalized}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Pubky-Homeserver-Dashboard/1' },
    });
    clearTimeout(timeout);
    const response = NextResponse.json({
      ok: res.ok,
      status: res.status,
      requestId,
    });
    logRouteInfo({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      message: 'Public health probe completed',
      meta: { ok: res.ok, upstreamStatus: res.status },
    });
    return response;
  } catch (e) {
    clearTimeout(timeout);
    const error = isAbortError(e)
      ? new RouteError(504, 'timeout', 'Public URL probe timed out')
      : new RouteError(502, 'upstream_error', 'Public URL probe failed');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: e instanceof Error ? e.message : String(e),
      meta: { domain: normalized },
    });
    return errorResponse(error, requestId, 'Public URL probe failed');
  }
}

export const GET = withAdminAuth(handleGet);
