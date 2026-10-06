import { NextRequest, NextResponse } from 'next/server';
import { RouteError, errorResponse, isAbortError } from '@/lib/server/errors';
import { INERT_CONTENT_HEADERS } from '@/lib/server/inert-content';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';

const UPSTREAM_TIMEOUT_MS = 60000;
const SUPPORTED_METHODS = new Set(['GET', 'POST', 'PUT', 'DELETE', 'PROPFIND', 'MKCOL', 'MOVE', 'COPY']);

/** Statuses that must not carry a body (Response throws otherwise). */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function getActualMethod(request: NextRequest, fallbackMethod: string): string {
  const overrideMethod = request.headers.get('X-HTTP-Method-Override');
  const actualMethod = (overrideMethod || fallbackMethod).toUpperCase();
  if (!SUPPORTED_METHODS.has(actualMethod)) {
    throw new RouteError(400, 'bad_request', `Unsupported WebDAV method: ${actualMethod}`);
  }
  return actualMethod;
}

function getAuthHeader(adminToken: string): string {
  const value = Buffer.from(`admin:${adminToken}`).toString('base64');
  return `Basic ${value}`;
}

function ensureSafePathSegments(segments: string[]): void {
  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new RouteError(400, 'bad_request', 'Invalid path segment');
    }
    if (segment.includes('\0') || segment.includes('/') || segment.includes('\\')) {
      throw new RouteError(400, 'bad_request', 'Invalid path segment');
    }
  }
}

function buildDavPath(pathSegments: string, actualMethod: string): string {
  const isDirectoryRequest = actualMethod === 'PROPFIND' || actualMethod === 'MKCOL';
  const needsTrailingSlash = isDirectoryRequest && pathSegments;

  const suffix = pathSegments ? `/${pathSegments}` : '';
  const normalizedSuffix = needsTrailingSlash && !suffix.endsWith('/') ? `${suffix}/` : suffix || '/';
  return `/dav${normalizedSuffix}`;
}

/**
 * Rewrite a MOVE/COPY Destination header for the upstream. The browser-side
 * service addresses destinations as dashboard proxy paths (/api/webdav/<dest>);
 * the upstream expects an absolute URL inside its own /dav tree, on the same
 * base the source path uses. Forwarding the proxy path verbatim made renames
 * fail or target the wrong tree.
 */
function rewriteDestination(destination: string, adminBaseUrl: string): string {
  let pathname: string;
  try {
    // Accepts both path-only and absolute-URL destinations; URL parsing also
    // resolves any "." / ".." segments so they cannot escape /dav.
    pathname = new URL(destination, 'http://destination.invalid').pathname;
  } catch {
    throw new RouteError(400, 'bad_request', 'Invalid Destination header');
  }
  if (pathname.startsWith('/api/webdav')) {
    pathname = pathname.slice('/api/webdav'.length);
  }
  if (pathname !== '/dav' && !pathname.startsWith('/dav/')) {
    pathname = `/dav${pathname.startsWith('/') ? '' : '/'}${pathname}`;
  }
  return new URL(pathname, adminBaseUrl).toString();
}

// Handle PROPFIND and other WebDAV methods via POST with X-HTTP-Method-Override header
export async function proxyWebDavRequest(
  request: NextRequest,
  paramsPromise: Promise<{ path: string[] }>,
  method: string,
) {
  const requestId = getRequestId(request);
  const startedAt = Date.now();
  const routeName = '/api/webdav/[...path]';
  const { path } = await paramsPromise;

  const adminBaseUrl = process.env.ADMIN_BASE_URL || '';
  const adminToken = process.env.ADMIN_TOKEN || '';

  if (!adminBaseUrl || !adminToken) {
    const error = new RouteError(500, 'config_error', 'WebDAV proxy is not configured');
    logRouteError({
      requestId,
      route: routeName,
      method,
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: error.message,
    });
    return errorResponse(error, requestId);
  }

  let actualMethod = method.toUpperCase();
  let webdavPath = '/dav/';

  try {
    ensureSafePathSegments(path);
    const pathSegments = path.join('/');
    actualMethod = getActualMethod(request, method);
    const allowedBodyMethods = new Set(['POST', 'PUT']);
    let body: Uint8Array<ArrayBuffer> | undefined;
    if (allowedBodyMethods.has(method.toUpperCase())) {
      // Raw bytes, not text: text round-tripping corrupts binary uploads.
      body = new Uint8Array(await request.arrayBuffer());
    }
    const commonHeaders: HeadersInit = {};
    const depth = request.headers.get('Depth');
    if (depth) commonHeaders['Depth'] = depth;

    const contentType = request.headers.get('Content-Type');
    if (contentType) commonHeaders['Content-Type'] = contentType;

    const destination = request.headers.get('Destination');
    if (destination) commonHeaders['Destination'] = rewriteDestination(destination, adminBaseUrl);

    webdavPath = buildDavPath(pathSegments, actualMethod);
    const url = new URL(webdavPath, adminBaseUrl);
    request.nextUrl.searchParams.forEach((value, key) => {
      url.searchParams.append(key, value);
    });

    // No retry: a timed-out AbortSignal is already spent, so retrying with it
    // could never succeed, and connection errors should surface at once.
    const response = await fetch(url.toString(), {
      method: actualMethod,
      headers: {
        ...commonHeaders,
        Authorization: getAuthHeader(adminToken),
      },
      body,
      // A proxy must not silently follow an upstream redirect to another origin.
      redirect: 'manual',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });

    logRouteInfo({
      requestId,
      route: routeName,
      method: actualMethod,
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
      message: 'WebDAV proxy request completed',
      meta: { path: webdavPath },
    });

    if (NULL_BODY_STATUSES.has(response.status)) {
      return new NextResponse(null, {
        status: response.status,
        headers: { ...INERT_CONTENT_HEADERS, 'X-Request-Id': requestId },
      });
    }

    // Stream the upstream body through untouched so binary downloads survive.
    const responseContentType = response.headers.get('Content-Type') || 'application/xml';
    return new NextResponse(response.body, {
      status: response.status,
      headers: {
        ...INERT_CONTENT_HEADERS,
        'Content-Type': responseContentType,
        'X-Request-Id': requestId,
      },
    });
  } catch (error) {
    const mapped =
      error instanceof RouteError
        ? error
        : isAbortError(error)
          ? new RouteError(504, 'timeout', 'Homeserver WebDAV request timed out')
          : new RouteError(502, 'upstream_error', 'Failed to connect to homeserver WebDAV');
    logRouteError({
      requestId,
      route: routeName,
      method: actualMethod,
      statusCode: mapped.status,
      durationMs: Date.now() - startedAt,
      errorType: mapped.type,
      message: error instanceof Error ? error.message : String(error),
      meta: { path: webdavPath },
    });
    return errorResponse(mapped, requestId);
  }
}
