import { NextRequest } from 'next/server';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { getRequestId, logRouteError } from '@/lib/server/logger';
import { proxyToUpstream } from '@/lib/server/upstream-proxy';
import { withSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = '/api/admin/[[...path]]';

type RouteParams = { params: Promise<{ path?: string[] }> };

/** The handler for one HTTP method: everything under /api/admin goes to the homeserver's admin API as it came. */
const proxy =
  (method: string) =>
  async (request: NextRequest, { params }: RouteParams) => {
    const { path } = await params;
    return proxyRequest(request, path ?? [], method);
  };

async function proxyRequest(request: NextRequest, pathSegments: string[], method: string) {
  const baseUrl = process.env.ADMIN_BASE_URL;
  const token = process.env.ADMIN_TOKEN;

  if (!baseUrl || !token) {
    const requestId = getRequestId(request);
    const error = new RouteError(500, 'config_error', 'Homeserver admin API is not configured');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method,
      statusCode: error.status,
      durationMs: 0,
      errorType: error.type,
      message: error.message,
    });
    return errorResponse(error, requestId);
  }

  return proxyToUpstream(request, pathSegments, method, {
    baseUrl,
    routeName: ROUTE_NAME,
    extraHeaders: { 'X-Admin-Password': token },
    defaultContentType: 'application/json',
  });
}

export const GET = withSession(proxy('GET'));
export const POST = withSession(proxy('POST'));
export const PUT = withSession(proxy('PUT'));
export const PATCH = withSession(proxy('PATCH'));
export const DELETE = withSession(proxy('DELETE'));
