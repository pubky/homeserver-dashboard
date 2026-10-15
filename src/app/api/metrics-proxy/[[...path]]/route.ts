import { NextRequest } from 'next/server';
import { proxyToUpstream } from '@/lib/server/upstream-proxy';
import { withSession } from '@/lib/server/session';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = '/api/metrics-proxy/[[...path]]';

// Same convention as ADMIN_BASE_URL: compose-internal hostname by default,
// overridable for non-Docker setups.
const DEFAULT_METRICS_BASE_URL = 'http://homeserver:6289';

type RouteParams = { params: Promise<{ path?: string[] }> };

// The metrics server is read-only; GET is all the API explorer offers for it.
async function handleGet(request: NextRequest, { params }: RouteParams) {
  const { path } = await params;
  return proxyToUpstream(request, path ?? [], 'GET', {
    baseUrl: process.env.METRICS_BASE_URL || DEFAULT_METRICS_BASE_URL,
    routeName: ROUTE_NAME,
  });
}

export const GET = withSession(handleGet);
