/**
 * The access check in front of every admin API route.
 *
 * It lives in the route handlers, through `withAdminAuth`, and not in a Next
 * proxy/middleware: a handler that checks for itself stays protected whatever
 * happens to request routing in front of it. `route-guard.test.ts` fails when
 * a route is exported without it.
 */
import { NextRequest, NextResponse } from 'next/server';
import { DASHBOARD_REQUEST_HEADER, DASHBOARD_REQUEST_VALUE } from '@/lib/dashboard-request';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { getRequestId, logRouteError } from '@/lib/server/logger';
import { type ActiveAuthConfig, getAuthConfig, isAdminKey } from './config';
import { sessionIdsOf } from './session-cookie';
import { type SessionView, getSession, touchSession } from './store';

const GUARDED = Symbol.for('homeserver-dashboard.admin-guarded');

const signedOut = () => new RouteError(401, 'unauthorized', 'Sign in to continue');
const crossSite = () => new RouteError(403, 'forbidden', 'Cross-site requests are not allowed');
const notFromPage = () => new RouteError(403, 'forbidden', 'This API only answers requests made by the dashboard page');
const signInOff = () => new RouteError(404, 'not_found', 'Sign-in is not enabled');
const misconfigured = (reason: string) => new RouteError(503, 'config_error', 'Sign-in is misconfigured', reason);

/**
 * False for a request a browser sent on behalf of another origin.
 *
 * The session cookie is SameSite=Strict, which already keeps it off requests
 * from other sites. "Site" is wider than "origin" though: a page on a sibling
 * subdomain, or on another port of the same host, counts as same-site and its
 * requests carry the cookie. So when the browser says where a request comes
 * from, only this exact origin passes. A request that carries neither header
 * tells us nothing either way; `isDashboardPageRequest` covers that case.
 */
export function isSameOriginRequest(request: NextRequest): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== null) return fetchSite === 'same-origin';

  // Sec-Fetch-Site is missing from old browsers and from plain-HTTP pages
  // that are not on localhost. Origin is still sent on state-changing requests.
  const origin = request.headers.get('origin');
  if (origin === null) return true;
  try {
    return new URL(origin).host === request.headers.get('host');
  } catch {
    return false;
  }
}

/** True for a request composed by the dashboard page's own script. See lib/dashboard-request.ts. */
function isDashboardPageRequest(request: NextRequest): boolean {
  return request.headers.get(DASHBOARD_REQUEST_HEADER) === DASHBOARD_REQUEST_VALUE;
}

function refusal(request: NextRequest | undefined, error: RouteError): NextResponse {
  const response = errorResponse(error, request ? getRequestId(request) : crypto.randomUUID());
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

function loggedRefusal(request: NextRequest, error: RouteError): NextResponse {
  logRouteError({
    requestId: getRequestId(request),
    route: request.nextUrl.pathname,
    method: request.method,
    statusCode: error.status,
    errorType: error.type,
    message: error.message,
  });
  return refusal(request, error);
}

/**
 * The request's live session for a key that is still an admin, or null.
 * Looking does not count as activity on the session.
 */
export function currentSession(request: NextRequest, config: ActiveAuthConfig): SessionView | null {
  const id = sessionIdsOf(request)[0];
  const session = id ? getSession(id) : null;
  // Checked on every request, so removing a key from ADMIN_PUBKEYS ends its sessions.
  return session && isAdminKey(config, session.admin) ? session : null;
}

/**
 * Null when the request may proceed, otherwise the response to send instead.
 * Everything that is not clearly allowed is refused.
 */
function refuseUnlessAdmin(request: NextRequest | undefined): NextResponse | null {
  const config = getAuthConfig();
  if (config.mode === 'off') return null;
  if (!request) return refusal(request, signedOut());
  if (config.mode === 'invalid') return loggedRefusal(request, misconfigured(config.reason));

  // Without a session there is nothing to protect and nothing worth a log
  // line: anyone can send such requests all day. So this comes first, and
  // does not yet count as activity, since the request may still be refused.
  const session = currentSession(request, config);
  if (!session) return refusal(request, signedOut());

  // From here on a signed-in browser is involved, so a refusal means
  // something tried to use an admin's session, and is logged.
  if (!isSameOriginRequest(request)) return loggedRefusal(request, crossSite());
  if (!isDashboardPageRequest(request)) return loggedRefusal(request, notFromPage());

  touchSession(session.id);
  return null;
}

/**
 * Wraps a route handler so it only runs for a signed-in admin (or when
 * sign-in is off). The wrapper keeps the handler's own parameter list. Next
 * always calls it with the request first, whether or not the handler declares it.
 */
export function withAdminAuth<A extends unknown[]>(
  handler: (...args: A) => Response | Promise<Response>,
): (...args: A) => Promise<Response> {
  const guarded = async (...args: A) => refuseUnlessAdmin(args[0] as NextRequest | undefined) ?? handler(...args);
  return Object.assign(guarded, { [GUARDED]: true });
}

/** True for a handler produced by `withAdminAuth`. */
export function isAdminGuarded(handler: unknown): boolean {
  return typeof handler === 'function' && (handler as { [GUARDED]?: boolean })[GUARDED] === true;
}

/** For signing out, which needs no session: the refusal for a cross-site request, or null. */
export function refuseCrossSite(request: NextRequest): NextResponse | null {
  return isSameOriginRequest(request) ? null : refusal(request, crossSite());
}

/**
 * For the routes that sign someone in, which anyone may call: the sign-in
 * settings when the request may go ahead, otherwise the response to send.
 */
export function signInRequest(
  request: NextRequest,
): { config: ActiveAuthConfig; refusal?: undefined } | { config?: undefined; refusal: NextResponse } {
  const config = getAuthConfig();
  if (config.mode === 'off') return { refusal: refusal(request, signInOff()) };
  if (config.mode === 'invalid') return { refusal: loggedRefusal(request, misconfigured(config.reason)) };
  const crossSiteRefusal = refuseCrossSite(request);
  return crossSiteRefusal ? { refusal: crossSiteRefusal } : { config };
}
