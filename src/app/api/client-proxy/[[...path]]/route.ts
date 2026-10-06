import { NextRequest } from 'next/server';
import { withAdminAuth } from '@/lib/server/auth/guard';
import { proxyToUpstream } from '@/lib/server/upstream-proxy';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = '/api/client-proxy/[[...path]]';

// Same convention as ADMIN_BASE_URL: compose-internal hostname by default,
// overridable for non-Docker setups.
const DEFAULT_CLIENT_BASE_URL = 'http://homeserver:6286';

type RouteParams = { params: Promise<{ path?: string[] }> };

async function handle(request: NextRequest, params: RouteParams['params'], method: string) {
  const { path } = await params;
  return proxyToUpstream(request, path ?? [], method, {
    baseUrl: process.env.CLIENT_BASE_URL || DEFAULT_CLIENT_BASE_URL,
    routeName: ROUTE_NAME,
  });
}

async function handleGet(request: NextRequest, { params }: RouteParams) {
  return handle(request, params, 'GET');
}

async function handleHead(request: NextRequest, { params }: RouteParams) {
  return handle(request, params, 'HEAD');
}

async function handlePost(request: NextRequest, { params }: RouteParams) {
  return handle(request, params, 'POST');
}

async function handlePut(request: NextRequest, { params }: RouteParams) {
  return handle(request, params, 'PUT');
}

async function handleDelete(request: NextRequest, { params }: RouteParams) {
  return handle(request, params, 'DELETE');
}

export const GET = withAdminAuth(handleGet);
export const HEAD = withAdminAuth(handleHead);
export const POST = withAdminAuth(handlePost);
export const PUT = withAdminAuth(handlePut);
export const DELETE = withAdminAuth(handleDelete);
