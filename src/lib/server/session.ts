import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { getRequestId } from '@/lib/server/logger';

export const SESSION_COOKIE = 'homeserver_dashboard_session';
const SESSION_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * The dashboard login password. Unset means no login: the dashboard is
 * reachable by anyone who can reach its port, as it always was. The Umbrel
 * app sets it, because there the port is also reachable from every other
 * app's container, behind the Umbrel login only for browsers.
 */
export function dashboardPassword(): string | undefined {
  return process.env.DASHBOARD_PASSWORD || undefined;
}

// Stateless: the cookie is a MAC of the password, so changing the password
// ends every session and there is nothing to store.
function sessionToken(password: string): string {
  return createHmac('sha256', password).update('homeserver-dashboard-session').digest('hex');
}

// Double HMAC under a throwaway key: equal-length digests for timingSafeEqual,
// and nothing derived from the inputs outlives the comparison.
const COMPARE_KEY = randomBytes(32);

function safeEqual(a: string, b: string): boolean {
  const digest = (value: string) => createHmac('sha256', COMPARE_KEY).update(value).digest();
  return timingSafeEqual(digest(a), digest(b));
}

export function isPasswordCorrect(candidate: string): boolean {
  const password = dashboardPassword();
  return password !== undefined && safeEqual(candidate, password);
}

export function hasValidSession(cookieValue: string | undefined): boolean {
  const password = dashboardPassword();
  if (password === undefined) return true;
  return cookieValue !== undefined && safeEqual(cookieValue, sessionToken(password));
}

export function setSessionCookie(response: NextResponse): void {
  const password = dashboardPassword();
  if (password === undefined) return;
  response.cookies.set(SESSION_COOKIE, sessionToken(password), {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

/**
 * Wraps a route handler so it answers 401 without a valid session. Checked
 * per route rather than in a proxy: a Next proxy buffers request bodies and
 * truncates them past its size limit, which would cut large uploads.
 */
export function withSession<A extends unknown[]>(
  handler: (request: NextRequest, ...rest: A) => Promise<Response>,
): (request: NextRequest, ...rest: A) => Promise<Response> {
  return async (request, ...rest) => {
    if (!hasValidSession(request.cookies.get(SESSION_COOKIE)?.value)) {
      return errorResponse(new RouteError(401, 'unauthorized', 'Log in to the dashboard first'), getRequestId(request));
    }
    return handler(request, ...rest);
  };
}
