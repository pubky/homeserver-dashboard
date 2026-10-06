import { NextRequest, NextResponse } from 'next/server';
import { getAuthConfig } from '@/lib/server/auth/config';
import { currentSession, refuseCrossSite } from '@/lib/server/auth/guard';
import { formatPubky } from '@/lib/server/auth/pubky-key';
import { clearSessionCookie, sessionIdsOf } from '@/lib/server/auth/session-cookie';
import { deleteSession } from '@/lib/server/auth/store';
import { getRequestId, logRouteInfo } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = '/api/auth/session';
const NO_STORE = { headers: { 'Cache-Control': 'no-store' } };

/**
 * GET /api/auth/session
 * Tells the page which screen to show: the dashboard, the sign-in, or a
 * configuration error. Public, and reveals only whether this browser is
 * signed in. Does not count as activity, so polling it cannot keep a session
 * alive.
 */
export async function GET(request: NextRequest) {
  const config = getAuthConfig();
  if (config.mode === 'off') return NextResponse.json({ authRequired: false }, NO_STORE);
  if (config.mode === 'invalid') {
    return NextResponse.json({ authRequired: true, authenticated: false, error: config.reason }, NO_STORE);
  }
  const session = currentSession(request, config);
  if (!session) return NextResponse.json({ authRequired: true, authenticated: false }, NO_STORE);
  return NextResponse.json(
    { authRequired: true, authenticated: true, pubky: formatPubky(session.admin), expiresAt: session.expiresAt },
    NO_STORE,
  );
}

/**
 * DELETE /api/auth/session
 * Signs out: ends every session this browser holds and clears its cookies.
 */
export async function DELETE(request: NextRequest) {
  const refusal = refuseCrossSite(request);
  if (refusal) return refusal;

  const ids = sessionIdsOf(request);
  ids.forEach(deleteSession);
  if (ids.length > 0) {
    const requestId = getRequestId(request);
    logRouteInfo({ requestId, route: ROUTE_NAME, method: 'DELETE', statusCode: 204, message: 'Admin signed out' });
  }
  const response = new NextResponse(null, { status: 204, ...NO_STORE });
  clearSessionCookie(response);
  return response;
}
