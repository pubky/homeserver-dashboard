/** The browser side of a session: the cookie that carries its id. */
import { NextRequest, NextResponse } from 'next/server';
import { SESSION_MAX_MS } from './store';

/** The cookie's name over plain HTTP (a LAN or tunnelled install). */
export const SESSION_COOKIE = 'homeserver_dashboard_session';
/**
 * Its name over HTTPS. The `__Host-` prefix makes browsers accept the cookie
 * only from this exact host over TLS, so a sibling subdomain cannot plant or
 * overwrite it.
 */
export const SECURE_SESSION_COOKIE = `__Host-${SESSION_COOKIE}`;

const COMMON_ATTRIBUTES = { httpOnly: true, sameSite: 'strict', path: '/' } as const;

/** True when the browser reached the dashboard over HTTPS, directly or through a TLS proxy. */
function isHttps(request: NextRequest): boolean {
  if (request.headers.get('origin')?.startsWith('https://')) return true;
  if (request.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https') return true;
  return request.nextUrl.protocol === 'https:';
}

/** Sets the session cookie on a sign-in response. */
export function setSessionCookie(response: NextResponse, request: NextRequest, sessionId: string): void {
  const maxAge = Math.floor(SESSION_MAX_MS / 1000);
  // Plain HTTP is how a LAN or tunnelled install is reached; a Secure cookie would never come back there.
  const secure = isHttps(request);
  const name = secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
  response.cookies.set({ ...COMMON_ATTRIBUTES, name, value: sessionId, secure, maxAge });
}

/** Clears the session cookie, under both of its names, on a sign-out response. */
export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set({ ...COMMON_ATTRIBUTES, name: SECURE_SESSION_COOKIE, value: '', secure: true, maxAge: 0 });
  response.cookies.set({ ...COMMON_ATTRIBUTES, name: SESSION_COOKIE, value: '', secure: false, maxAge: 0 });
}

/**
 * Every session id a request carries, the host-locked one first: only this
 * host can have set that one, while the plain one could have been planted
 * from elsewhere. A browser that signed in over HTTP and later over HTTPS
 * holds both.
 */
export function sessionIdsOf(request: NextRequest): string[] {
  return [request.cookies.get(SECURE_SESSION_COOKIE)?.value, request.cookies.get(SESSION_COOKIE)?.value].filter(
    (id): id is string => Boolean(id),
  );
}
