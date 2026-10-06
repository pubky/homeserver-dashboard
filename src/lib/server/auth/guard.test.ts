// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newIdentity } from './__fixtures__/ring';
import { isAdminGuarded, isSameOriginRequest, withAdminAuth } from './guard';
import { SECURE_SESSION_COOKIE, SESSION_COOKIE } from './session-cookie';
import { SESSION_IDLE_MS, createSession, resetAuthStore } from './store';

const ENDPOINT = 'http://dashboard.test/api/admin/info';

/** A request as the dashboard page's own script sends it, unless `headers` says otherwise. */
function request(headers: Record<string, string | undefined> = {}, method = 'GET'): NextRequest {
  const all: Record<string, string | undefined> = { host: 'dashboard.test', 'x-dashboard-request': '1', ...headers };
  const present = Object.fromEntries(Object.entries(all).filter(([, value]) => value !== undefined)) as Record<
    string,
    string
  >;
  return new NextRequest(ENDPOINT, { method, headers: present });
}

const withSession = (id: string, headers: Record<string, string | undefined> = {}) => ({
  cookie: `other=1; ${SESSION_COOKIE}=${id}`,
  ...headers,
});

describe('withAdminAuth', () => {
  const originalEnv = { ...process.env };
  const admin = newIdentity();
  const handler = vi.fn(async () => NextResponse.json({ secret: 'admin-only' }));
  const guarded = withAdminAuth(handler);

  beforeEach(() => {
    resetAuthStore();
    handler.mockClear();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.ADMIN_PUBKEYS = admin.pubky;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** The response, plus proof the handler did or did not run. */
  async function call(req: NextRequest | undefined) {
    const response = await (guarded as (r?: NextRequest) => Promise<Response>)(req);
    return { status: response.status, body: await response.text(), ran: handler.mock.calls.length > 0 };
  }

  it('runs the handler without any sign-in when ADMIN_PUBKEYS is not set', async () => {
    delete process.env.ADMIN_PUBKEYS;
    expect(await call(request())).toMatchObject({ status: 200, ran: true });
    // No header rule either: scripts and probes keep working as before.
    expect(await call(request({ 'x-dashboard-request': undefined }))).toMatchObject({ status: 200 });
    expect(await call(undefined)).toMatchObject({ status: 200 });
  });

  it('refuses a request with no session cookie', async () => {
    const result = await call(request());
    expect(result).toMatchObject({ status: 401, ran: false });
    expect(result.body).not.toContain('admin-only');
  });

  it('refuses requests without a session quietly, whatever else is wrong with them', async () => {
    // Anyone can send these; they must not be able to fill the log.
    const shapes = [{}, { 'x-dashboard-request': undefined }, { 'sec-fetch-site': 'cross-site' }, { origin: 'null' }];
    for (const headers of shapes) {
      expect(await call(request(headers))).toMatchObject({ status: 401, ran: false });
    }
    expect(console.error).not.toHaveBeenCalled();
  });

  it('logs when a signed-in browser is steered at the API', async () => {
    const id = createSession(admin.publicKey);
    expect((await call(request(withSession(id, { 'x-dashboard-request': undefined })))).status).toBe(403);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it('does not count a refused request as activity', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const id = createSession(admin.publicKey);
    vi.advanceTimersByTime(SESSION_IDLE_MS - 1000);
    // Something makes the admin's browser send requests that get refused...
    expect((await call(request(withSession(id, { 'sec-fetch-site': 'cross-site' })))).status).toBe(403);
    vi.advanceTimersByTime(2000);
    // ...and the session still ends on schedule.
    expect(await call(request(withSession(id)))).toMatchObject({ status: 401, ran: false });
  });

  it.each([
    ['an empty cookie value', ''],
    ['a made-up session id', 'A'.repeat(43)],
    ['an id that only shares a prefix with a real one', 'PREFIX'],
  ])('refuses %s', async (_case, value) => {
    const real = createSession(admin.publicKey);
    const id = value === 'PREFIX' ? real.slice(0, -1) : value;
    expect(await call(request(withSession(id)))).toMatchObject({ status: 401, ran: false });
  });

  it('runs the handler for a live session', async () => {
    const id = createSession(admin.publicKey);
    expect(await call(request(withSession(id)))).toMatchObject({ status: 200, ran: true });
  });

  it('passes the handler its own arguments', async () => {
    const id = createSession(admin.publicKey);
    const inner = vi.fn(async (_req: NextRequest, context: { params: string }) => NextResponse.json(context));
    const req = request(withSession(id));
    const response = await withAdminAuth(inner)(req, { params: 'p' });
    expect(await response.json()).toEqual({ params: 'p' });
    expect(inner).toHaveBeenCalledWith(req, { params: 'p' });
  });

  it('refuses a session once it has been idle too long', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const id = createSession(admin.publicKey);
    vi.advanceTimersByTime(SESSION_IDLE_MS + 1);
    expect(await call(request(withSession(id)))).toMatchObject({ status: 401, ran: false });
  });

  it('keeps an active session alive past the idle limit', async () => {
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    const id = createSession(admin.publicKey);
    vi.advanceTimersByTime(SESSION_IDLE_MS - 1000);
    expect((await call(request(withSession(id)))).status).toBe(200);
    vi.advanceTimersByTime(SESSION_IDLE_MS - 1000);
    expect((await call(request(withSession(id)))).status).toBe(200);
  });

  it('refuses a session whose key has been removed from ADMIN_PUBKEYS', async () => {
    const id = createSession(admin.publicKey);
    process.env.ADMIN_PUBKEYS = newIdentity().pubky;
    expect(await call(request(withSession(id)))).toMatchObject({ status: 401, ran: false });
  });

  it('refuses everything while ADMIN_PUBKEYS is unusable, even a live session', async () => {
    const id = createSession(admin.publicKey);
    for (const broken of ['', 'not-a-pubky', `${admin.pubky},oops`]) {
      process.env.ADMIN_PUBKEYS = broken;
      expect(await call(request(withSession(id)))).toMatchObject({ status: 503, ran: false });
    }
  });

  it('refuses when there is no request to check', async () => {
    expect(await call(undefined)).toMatchObject({ status: 401, ran: false });
  });

  describe('requests the dashboard page did not make', () => {
    it.each([
      ['another site', { 'sec-fetch-site': 'cross-site' }],
      ['a sibling subdomain', { 'sec-fetch-site': 'same-site' }],
      ['the address bar, a bookmark or a link in another app', { 'sec-fetch-site': 'none' }],
      ['an unknown Sec-Fetch-Site value', { 'sec-fetch-site': 'something-new' }],
      ['another origin, from a browser without Sec-Fetch-Site', { origin: 'http://evil.test' }],
      ['the same host on another port', { origin: 'http://dashboard.test:8081' }],
      ['an opaque origin', { origin: 'null' }],
    ])('refuses a request from %s even with a live session', async (_case, headers) => {
      const id = createSession(admin.publicKey);
      for (const method of ['GET', 'POST']) {
        handler.mockClear();
        expect(await call(request(withSession(id, headers), method))).toMatchObject({ status: 403, ran: false });
      }
    });

    it.each([
      ['no header at all (a link, an image, a frame, a form)', undefined],
      ['an empty value', ''],
      ['another value', 'true'],
    ])('refuses a request with a live session but %s for the dashboard header', async (_case, value) => {
      const id = createSession(admin.publicKey);
      // Neither Sec-Fetch-Site nor Origin: what a plain-HTTP page on another port can produce.
      const result = await call(request(withSession(id, { 'x-dashboard-request': value })));
      expect(result).toMatchObject({ status: 403, ran: false });
      // Even when the browser vouches that the request is same-origin.
      const sameOrigin = { 'x-dashboard-request': value, 'sec-fetch-site': 'same-origin' };
      expect(await call(request(withSession(id, sameOrigin)))).toMatchObject({ status: 403, ran: false });
    });

    it.each([
      ['this origin', { 'sec-fetch-site': 'same-origin' }],
      ['this origin, from a browser without Sec-Fetch-Site', { origin: 'http://dashboard.test' }],
      ['a page on plain HTTP, where the browser sends neither header', {}],
    ])('allows the dashboard page itself, from %s', async (_case, headers) => {
      const id = createSession(admin.publicKey);
      expect(await call(request(withSession(id, headers), 'POST'))).toMatchObject({ status: 200, ran: true });
    });

    it('does not let the dashboard header stand in for a session', async () => {
      expect(await call(request({ 'sec-fetch-site': 'same-origin' }))).toMatchObject({ status: 401, ran: false });
    });

    it('trusts Sec-Fetch-Site over a matching Origin', () => {
      expect(isSameOriginRequest(request({ 'sec-fetch-site': 'cross-site', origin: 'http://dashboard.test' }))).toBe(
        false,
      );
    });
  });

  describe('the session cookie', () => {
    it('is read under its HTTPS name too', async () => {
      const id = createSession(admin.publicKey);
      const result = await call(request({ cookie: `${SECURE_SESSION_COOKIE}=${id}` }));
      expect(result).toMatchObject({ status: 200, ran: true });
    });

    it('prefers the host-locked cookie, so a planted plain one cannot sign the admin out', async () => {
      const id = createSession(admin.publicKey);
      const cookie = `${SESSION_COOKIE}=planted-by-a-sibling-subdomain; ${SECURE_SESSION_COOKIE}=${id}`;
      expect(await call(request({ cookie }))).toMatchObject({ status: 200, ran: true });
    });
  });

  it('marks what it wraps, and nothing else', () => {
    expect(isAdminGuarded(guarded)).toBe(true);
    expect(isAdminGuarded(handler)).toBe(false);
    expect(isAdminGuarded(undefined)).toBe(false);
  });
});
