import { NextRequest, NextResponse } from 'next/server';
import { RouteError, errorResponse, isAbortError } from '@/lib/server/errors';
import { INERT_CONTENT_HEADERS } from '@/lib/server/inert-content';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';

const UPSTREAM_TIMEOUT_MS = 60000;

/** Request headers copied through to the upstream. */
const FORWARDED_REQUEST_HEADERS = new Set(['accept', 'content-type', 'if-none-match', 'if-match', 'user-agent']);

/** Statuses that must not carry a body (Response throws otherwise). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function getForwardHeaders(request: NextRequest): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [rawKey, value] of request.headers.entries()) {
    if (FORWARDED_REQUEST_HEADERS.has(rawKey.toLowerCase())) {
      result[rawKey] = value;
    }
  }
  return result;
}

export type UpstreamProxyOptions = {
  /** Absolute base URL of the upstream server. */
  baseUrl: string;
  /** Route name used in log lines. */
  routeName: string;
  /** Extra headers sent to the upstream (e.g. admin auth). */
  extraHeaders?: Record<string, string>;
  /** Content-Type used when the upstream response does not set one. */
  defaultContentType?: string;
};

/**
 * Forwards a request to an upstream homeserver port and relays the response.
 * The request body is relayed as raw bytes and the response body is streamed,
 * so binary payloads survive the round trip. There is deliberately no retry
 * here: a timed-out AbortSignal is already spent, so retrying with it could
 * never succeed, and connection errors should surface to the caller at once.
 */
export async function proxyToUpstream(
  request: NextRequest,
  pathSegments: string[],
  method: string,
  { baseUrl, routeName, extraHeaders, defaultContentType }: UpstreamProxyOptions,
): Promise<NextResponse> {
  const requestId = getRequestId(request);
  const startedAt = Date.now();
  const path = '/' + pathSegments.join('/');
  const url = new URL(path, baseUrl);

  // A path that resolves to a different origin (protocol-relative `//host` from
  // an encoded `%2F%2F`, a backslash, etc.) would make us fetch an attacker
  // host - and, for the admin proxy, send X-Admin-Password there. Pin the
  // request to the upstream origin before forwarding anything.
  if (url.origin !== new URL(baseUrl).origin) {
    const mapped = new RouteError(400, 'bad_request', 'Invalid proxy path');
    logRouteError({
      requestId,
      route: routeName,
      method,
      statusCode: mapped.status,
      durationMs: Date.now() - startedAt,
      errorType: mapped.type,
      message: mapped.message,
      meta: { path },
    });
    return errorResponse(mapped, requestId);
  }

  // Forward query parameters
  request.nextUrl.searchParams.forEach((value, key) => {
    url.searchParams.append(key, value);
  });

  try {
    const body = method !== 'GET' && method !== 'HEAD' ? new Uint8Array(await request.arrayBuffer()) : undefined;
    const response = await fetch(url.toString(), {
      method,
      cache: 'no-store',
      // The origin pin above only constrains the initial request. Do not follow
      // a redirect: a coerced cross-origin 3xx would otherwise carry the
      // injected X-Admin-Password header to the redirect target (undici strips
      // Authorization/Cookie cross-origin but not our custom header).
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        ...extraHeaders,
        ...getForwardHeaders(request),
      },
      body,
    });

    logRouteInfo({
      requestId,
      route: routeName,
      method,
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      message: 'Proxy request completed',
      meta: { path },
    });

    const headers: Record<string, string> = {
      ...INERT_CONTENT_HEADERS,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      Pragma: 'no-cache',
      Expires: '0',
      'X-Request-Id': requestId,
    };
    const contentType = response.headers.get('Content-Type') || defaultContentType;
    if (contentType) {
      headers['Content-Type'] = contentType;
    }

    return new NextResponse(NULL_BODY_STATUSES.has(response.status) ? null : response.body, {
      status: response.status,
      headers,
    });
  } catch (error) {
    const mapped = isAbortError(error)
      ? new RouteError(504, 'timeout', 'Homeserver request timed out')
      : new RouteError(502, 'upstream_error', 'Failed to connect to homeserver');
    logRouteError({
      requestId,
      route: routeName,
      method,
      statusCode: mapped.status,
      durationMs: Date.now() - startedAt,
      errorType: mapped.type,
      message: error instanceof Error ? error.message : String(error),
      meta: { path, targetHost: new URL(baseUrl).host },
    });
    return errorResponse(mapped, requestId);
  }
}
