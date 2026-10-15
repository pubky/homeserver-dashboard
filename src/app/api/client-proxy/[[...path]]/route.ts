import { NextRequest } from 'next/server';
import { proxyToUpstream } from '@/lib/server/upstream-proxy';
import { withSession } from '@/lib/server/session';

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

export const GET = withSession(handleGet);
export const HEAD = withSession(handleHead);
export const POST = withSession(handlePost);
export const PUT = withSession(handlePut);
export const DELETE = withSession(handleDelete);
