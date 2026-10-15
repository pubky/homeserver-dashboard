import { NextRequest, NextResponse } from 'next/server';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';
import { dashboardPassword, isPasswordCorrect, setSessionCookie } from '@/lib/server/session';

const ROUTE_NAME = '/api/auth/login';

/**
 * POST /api/auth/login  { "password": "..." }
 * Sets the session cookie when the password matches DASHBOARD_PASSWORD.
 * Answers 404 when no password is configured, since there is no login then.
 */
export async function POST(request: NextRequest) {
  const requestId = getRequestId(request);
  const startedAt = Date.now();

  const fail = (error: RouteError) => {
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
  };

  if (dashboardPassword() === undefined) {
    return fail(new RouteError(404, 'not_supported', 'This dashboard has no login'));
  }

  const body: unknown = await request.json().catch(() => null);
  const candidate =
    typeof body === 'object' && body !== null && 'password' in body && typeof body.password === 'string'
      ? body.password
      : '';
  if (!isPasswordCorrect(candidate)) {
    return fail(new RouteError(401, 'unauthorized', 'Wrong password'));
  }

  logRouteInfo({
    requestId,
    route: ROUTE_NAME,
    method: 'POST',
    statusCode: 204,
    durationMs: Date.now() - startedAt,
    message: 'Logged in',
  });
  const response = new NextResponse(null, { status: 204 });
  setSessionCookie(response);
  return response;
}
