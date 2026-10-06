/**
 * How the dashboard's own page marks its API requests.
 *
 * With admin sign-in on, the API only answers requests that carry this
 * header. A browser lets a page add a custom header only to requests its own
 * script makes to its own origin: a link, an address-bar visit, an <img> or
 * <iframe>, a form, and any script on another site cannot send it. So the
 * header separates "the dashboard page asked" from "something got the admin's
 * browser to ask", without relying on which optional headers a given browser
 * or connection sends.
 *
 * It is not a secret and not a credential. The session cookie is the
 * credential; this only says who composed the request.
 */
export const DASHBOARD_REQUEST_HEADER = 'x-dashboard-request';
export const DASHBOARD_REQUEST_VALUE = '1';

const INSTALLED = Symbol.for('homeserver-dashboard.request-header');

function isOwnApiRequest(input: RequestInfo | URL): boolean {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, window.location.href);
    return url.origin === window.location.origin && url.pathname.startsWith('/api/');
  } catch {
    return false;
  }
}

/**
 * Makes every `fetch` this page sends to its own `/api/` carry the header.
 * Done once, in one place, so no call site can forget it; a request without
 * the header is refused, never let through, so the worst a gap can do is break
 * a feature visibly. Requests to anywhere else are passed on untouched.
 */
export function installDashboardRequestHeader(): void {
  if (typeof window === 'undefined') return;
  const current = window.fetch as typeof window.fetch & { [INSTALLED]?: true };
  if (current[INSTALLED]) return;

  const withHeader: typeof window.fetch = (input, init) => {
    if (!isOwnApiRequest(input)) return current.call(window, input, init);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    headers.set(DASHBOARD_REQUEST_HEADER, DASHBOARD_REQUEST_VALUE);
    return current.call(window, input, { ...init, headers });
  };
  window.fetch = Object.assign(withHeader, { [INSTALLED]: true as const });
}
