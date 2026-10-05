import { NextRequest, NextResponse } from 'next/server';
import { getAdminToken } from '@/lib/server/admin-token';
import { RouteError, errorResponse, isAbortError } from '@/lib/server/errors';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';

const ROUTE_NAME = '/api/admin/generate_signup_token';
const UPSTREAM_TIMEOUT_MS = 8000;

export async function GET(request: NextRequest) {
  const requestId = getRequestId(request);
  const startedAt = Date.now();
  const baseUrl = process.env.ADMIN_BASE_URL;
  const token = await getAdminToken();

  if (!baseUrl || !token) {
    const error = new RouteError(500, 'config_error', 'Homeserver admin API is not configured');
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

  try {
    const response = await fetch(`${baseUrl}/generate_signup_token`, {
      method: 'GET',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      headers: {
        'X-Admin-Password': token,
      },
    });

    if (!response.ok) {
      const error = new RouteError(response.status, 'upstream_error', 'Failed to generate invite token');
      logRouteError({
        requestId,
        route: ROUTE_NAME,
        method: 'GET',
        statusCode: error.status,
        durationMs: Date.now() - startedAt,
        errorType: error.type,
        message: `Upstream status ${response.status}`,
      });
      return errorResponse(error, requestId);
    }

    const text = await response.text();
    logRouteInfo({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      message: 'Invite token generated',
    });
    return NextResponse.json({ token: text, requestId });
  } catch (error) {
    const mapped = isAbortError(error)
      ? new RouteError(504, 'timeout', 'Homeserver request timed out')
      : new RouteError(502, 'upstream_error', 'Failed to connect to homeserver');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: mapped.status,
      durationMs: Date.now() - startedAt,
      errorType: mapped.type,
      message: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(mapped, requestId);
  }
}
