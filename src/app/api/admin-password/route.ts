import { NextRequest, NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/server/auth/guard';
import { getAdminToken } from '@/lib/server/admin-token';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';

const ROUTE_NAME = '/api/admin-password';

/**
 * GET /api/admin-password
 * Returns the admin password this dashboard uses to authenticate to the
 * homeserver (see getAdminToken). Exposed so operators can connect
 * other tools (e.g. pubky-cli) without digging it out of config.toml -
 * which, on managed deployments, they must not edit anyway.
 *
 * No privilege escalation: anyone who can reach this route already has the
 * full admin UI (invites, user management, config editing). The value is
 * only returned on explicit request, never embedded in other responses,
 * and never logged.
 */
async function handleGet(request: NextRequest) {
  const requestId = getRequestId(request);
  const startedAt = Date.now();

  const password = await getAdminToken();
  if (!password) {
    const error = new RouteError(404, 'not_found', 'Admin password is not configured in this environment');
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

  logRouteInfo({
    requestId,
    route: ROUTE_NAME,
    method: 'GET',
    statusCode: 200,
    durationMs: Date.now() - startedAt,
    message: 'Admin password revealed',
  });
  return NextResponse.json({ password, requestId }, { headers: { 'Cache-Control': 'no-store' } });
}

export const GET = withAdminAuth(handleGet);
