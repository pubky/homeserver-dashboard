import { NextRequest } from 'next/server';
import { withAdminAuth } from '@/lib/server/auth/guard';
import { getAdminToken } from '@/lib/server/admin-token';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { getRequestId, logRouteError } from '@/lib/server/logger';
import { proxyToUpstream } from '@/lib/server/upstream-proxy';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = '/api/admin/[[...path]]';

type RouteParams = { params: Promise<{ path?: string[] }> };

async function handleGet(request: NextRequest, { params }: RouteParams) {
  const { path } = await params;
  return proxyRequest(request, path ?? [], 'GET');
}

async function handlePost(request: NextRequest, { params }: RouteParams) {
  const { path } = await params;
  return proxyRequest(request, path ?? [], 'POST');
}

async function handlePut(request: NextRequest, { params }: RouteParams) {
  const { path } = await params;
  return proxyRequest(request, path ?? [], 'PUT');
}

async function handleDelete(request: NextRequest, { params }: RouteParams) {
  const { path } = await params;
  return proxyRequest(request, path ?? [], 'DELETE');
}

async function proxyRequest(request: NextRequest, pathSegments: string[], method: string) {
  const baseUrl = process.env.ADMIN_BASE_URL;
  const token = await getAdminToken();

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

export const GET = withAdminAuth(handleGet);
export const POST = withAdminAuth(handlePost);
export const PUT = withAdminAuth(handlePut);
export const DELETE = withAdminAuth(handleDelete);
