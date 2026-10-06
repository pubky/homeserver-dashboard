// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as getAdminPassword } from '@/app/api/admin-password/route';
import { newIdentity, signToken } from '@/lib/server/auth/__fixtures__/ring';
import { SECURE_SESSION_COOKIE, SESSION_COOKIE } from '@/lib/server/auth/session-cookie';
import { resetAuthStore } from '@/lib/server/auth/store';
import { POST as postChallenge } from './challenge/route';
import { POST as postLogin } from './login/route';
import { DELETE as deleteSessionRoute, GET as getSessionRoute } from './session/route';

const ORIGIN = 'http://dashboard.test';

function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method: init.method ?? 'GET',
    // As the dashboard page's script sends its requests.
    headers: { host: 'dashboard.test', 'x-dashboard-request': '1', ...init.headers },
    body: init.body,
  });
}

type SetCookie = { name: string; value: string; attributes: string };

/** Every session cookie (under either name) a response sets. */
function sessionCookies(response: Response): SetCookie[] {
  return response.headers
    .getSetCookie()
    .map((header) => {
      const [pair, ...attributes] = header.split('; ');
      const equals = pair.indexOf('=');
      return {
        name: pair.slice(0, equals),
        value: pair.slice(equals + 1),
        attributes: attributes.join('; ').toLowerCase(),
      };
    })
    .filter((cookie) => cookie.name === SESSION_COOKIE || cookie.name === SECURE_SESSION_COOKIE);
}

/** The one session cookie a sign-in response sets, or null. */
function sessionCookie(response: Response): SetCookie | null {
  const cookies = sessionCookies(response);
  if (cookies.length > 1) throw new Error('expected at most one session cookie');
  return cookies[0] ?? null;
}

describe('admin sign-in routes', () => {
  const originalEnv = { ...process.env };
  const admin = newIdentity();
  const stranger = newIdentity();

  beforeEach(() => {
    resetAuthStore();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.ADMIN_PUBKEYS = admin.pubky;
    process.env.ADMIN_TOKEN = 'the-admin-password';
    delete process.env.AUTH_RELAY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  async function startAttempt() {
    const response = await postChallenge(request('/api/auth/challenge', { method: 'POST' }));
    return { response, ...((await response.json()) as { capability: string; verifier: string; relay: string | null }) };
  }

  function login(token: Uint8Array, verifier: string, headers: Record<string, string> = {}) {
    return postLogin(
      request('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ token: Buffer.from(token).toString('base64'), verifier }),
      }),
    );
  }

  /** Signs in as `identity` the way the page and Ring do, and returns the login response. */
  async function signInAs(identity = admin, headers: Record<string, string> = {}) {
    const { capability, verifier } = await startAttempt();
    return login(signToken(identity, capability), verifier, headers);
  }

  const withCookie = (value: string) => ({ cookie: `${SESSION_COOKIE}=${value}` });

  it('walks the whole path: refused, signed in, allowed, signed out, refused', async () => {
    expect((await getAdminPassword(request('/api/admin-password'))).status).toBe(401);

    const loginResponse = await signInAs();
    expect(loginResponse.status).toBe(200);
    expect(await loginResponse.json()).toMatchObject({ pubky: admin.pubky });
    const cookie = sessionCookie(loginResponse);
    expect(cookie?.value.length).toBeGreaterThanOrEqual(43);

    const allowed = await getAdminPassword(request('/api/admin-password', { headers: withCookie(cookie!.value) }));
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ password: 'the-admin-password' });

    const status = await getSessionRoute(request('/api/auth/session', { headers: withCookie(cookie!.value) }));
    expect(await status.json()).toMatchObject({ authRequired: true, authenticated: true, pubky: admin.pubky });

    const logout = await deleteSessionRoute(
      request('/api/auth/session', { method: 'DELETE', headers: withCookie(cookie!.value) }),
    );
    expect(logout.status).toBe(204);
    // Both names are cleared, whichever one this browser holds.
    expect(
      sessionCookies(logout)
        .map((c) => [c.name, c.value])
        .sort(),
    ).toEqual([
      [SECURE_SESSION_COOKIE, ''],
      [SESSION_COOKIE, ''],
    ]);
    for (const cleared of sessionCookies(logout)) expect(cleared.attributes).toContain('max-age=0');

    const after = await getAdminPassword(request('/api/admin-password', { headers: withCookie(cookie!.value) }));
    expect(after.status).toBe(401);
  });

  it('sets a cookie scripts cannot read and other sites cannot send', async () => {
    const cookie = sessionCookie(await signInAs());
    expect(cookie?.attributes).toContain('httponly');
    expect(cookie?.attributes).toContain('samesite=strict');
    expect(cookie?.attributes).toContain('path=/');
    expect(cookie?.attributes).not.toContain('domain=');
    expect(cookie?.attributes).not.toContain('secure');
    expect(cookie?.name).toBe(SESSION_COOKIE);
  });

  it.each([
    ['the page was loaded over HTTPS', { origin: 'https://dashboard.test', 'sec-fetch-site': 'same-origin' }],
    ['a TLS proxy says so', { 'x-forwarded-proto': 'https' }],
  ])('uses the host-locked Secure cookie when %s', async (_case, headers) => {
    const cookie = sessionCookie(await signInAs(admin, headers));
    expect(cookie?.name).toBe(SECURE_SESSION_COOKIE);
    expect(cookie?.attributes).toContain('secure');
    expect(cookie?.attributes).toContain('path=/');
    expect(cookie?.attributes).not.toContain('domain=');
    // And the guard accepts it under that name.
    const allowed = await getAdminPassword(
      request('/api/admin-password', { headers: { cookie: `${SECURE_SESSION_COOKIE}=${cookie!.value}` } }),
    );
    expect(allowed.status).toBe(200);
  });

  it('refuses a non-admin, sets no cookie, and says why', async () => {
    const response = await signInAs(stranger);
    expect(response.status).toBe(403);
    expect(sessionCookie(response)).toBeNull();
    expect((await response.json()).error).toMatch(/not an admin/);
  });

  it('refuses a replayed login', async () => {
    const { capability, verifier } = await startAttempt();
    const token = signToken(admin, capability);
    expect((await login(token, verifier)).status).toBe(200);
    const replay = await login(token, verifier);
    expect(replay.status).toBe(401);
    expect(sessionCookie(replay)).toBeNull();
  });

  it('refuses a token taken from one attempt and presented without its verifier', async () => {
    const victim = await startAttempt();
    const thief = await startAttempt();
    const token = signToken(admin, victim.capability);
    const response = await login(token, thief.verifier);
    expect(response.status).toBe(401);
    expect(sessionCookie(response)).toBeNull();
  });

  it('refuses a token the admin signed for another application', async () => {
    const { verifier } = await startAttempt();
    const response = await login(signToken(admin, '/pub/some-app/:rw'), verifier);
    expect(response.status).toBe(401);
    expect(sessionCookie(response)).toBeNull();
  });

  it.each([
    ['not JSON', 'token=abc'],
    ['an empty body', ''],
    ['missing fields', '{}'],
    ['a token that is not text', '{"token":123,"verifier":"v"}'],
    ['a token that is not base64', '{"token":"<script>","verifier":"v"}'],
    ['an empty verifier', '{"token":"AAAA","verifier":""}'],
    ['an oversized body', JSON.stringify({ token: 'A'.repeat(20_000), verifier: 'v' })],
  ])('answers 400 to %s', async (_case, body) => {
    const response = await postLogin(request('/api/auth/login', { method: 'POST', body }));
    expect(response.status).toBe(400);
    expect(sessionCookie(response)).toBeNull();
  });

  it('refuses login, challenge and logout requests made for another site', async () => {
    const { capability, verifier } = await startAttempt();
    const crossSite = { 'sec-fetch-site': 'cross-site' };
    expect((await login(signToken(admin, capability), verifier, crossSite)).status).toBe(403);
    expect((await postChallenge(request('/api/auth/challenge', { method: 'POST', headers: crossSite }))).status).toBe(
      403,
    );

    const cookie = sessionCookie(await signInAs());
    const logout = await deleteSessionRoute(
      request('/api/auth/session', { method: 'DELETE', headers: { ...withCookie(cookie!.value), ...crossSite } }),
    );
    expect(logout.status).toBe(403);
    // The cross-site logout did not end the session.
    const still = await getAdminPassword(request('/api/admin-password', { headers: withCookie(cookie!.value) }));
    expect(still.status).toBe(200);
  });

  it('refuses a signed-in browser that was merely sent to an API address', async () => {
    const cookie = sessionCookie(await signInAs());
    // A link, a bookmark, an <img> or an <iframe>: the cookie goes along, the dashboard's header cannot.
    const browserHeaders: Record<string, string>[] = [
      {},
      { 'sec-fetch-site': 'none' },
      { 'sec-fetch-site': 'same-origin' },
    ];
    for (const headers of browserHeaders) {
      const response = await getAdminPassword(
        new NextRequest(`${ORIGIN}/api/admin-password`, {
          headers: { host: 'dashboard.test', ...withCookie(cookie!.value), ...headers },
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain('the-admin-password');
    }
  });

  it('gives the same answer for a captured token whoever signed it', async () => {
    const { capability } = await startAttempt();
    const answers = [];
    for (const signer of [admin, stranger]) {
      const response = await login(signToken(signer, capability), 'no-verifier');
      answers.push({ status: response.status, error: (await response.json()).error });
    }
    expect(answers[0].status).toBe(401);
    expect(answers[1]).toEqual(answers[0]);
  });

  it('stops reading an oversized body that does not announce its size', async () => {
    let chunksPulled = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        chunksPulled += 1;
        controller.enqueue(new Uint8Array(4096).fill(0x41));
      },
    });
    const response = await postLogin(
      new NextRequest(`${ORIGIN}/api/auth/login`, {
        method: 'POST',
        headers: { host: 'dashboard.test' },
        body: endless,
        duplex: 'half',
      } as ConstructorParameters<typeof NextRequest>[1]),
    );
    expect(response.status).toBe(400);
    // It gave up after the limit instead of buffering the stream.
    expect(chunksPulled).toBeLessThan(10);
  });

  it('signs out every session the browser holds, under both cookie names', async () => {
    const overHttp = sessionCookie(await signInAs());
    const overHttps = sessionCookie(await signInAs(admin, { 'x-forwarded-proto': 'https' }));
    expect([overHttp?.name, overHttps?.name]).toEqual([SESSION_COOKIE, SECURE_SESSION_COOKIE]);

    const both = `${SESSION_COOKIE}=${overHttp!.value}; ${SECURE_SESSION_COOKIE}=${overHttps!.value}`;
    const logout = await deleteSessionRoute(
      request('/api/auth/session', { method: 'DELETE', headers: { cookie: both } }),
    );
    expect(logout.status).toBe(204);

    for (const cookie of [`${SESSION_COOKIE}=${overHttp!.value}`, `${SECURE_SESSION_COOKIE}=${overHttps!.value}`]) {
      const after = await getAdminPassword(request('/api/admin-password', { headers: { cookie } }));
      expect(after.status).toBe(401);
    }
  });

  it('never caches sign-in responses', async () => {
    const attempt = await startAttempt();
    expect(attempt.response.headers.get('cache-control')).toBe('no-store');
    expect((await signInAs()).headers.get('cache-control')).toBe('no-store');
    expect((await getSessionRoute(request('/api/auth/session'))).headers.get('cache-control')).toBe('no-store');
  });

  it('hands the page the capability, a verifier and the configured relay', async () => {
    process.env.AUTH_RELAY = 'https://relay.example/link/';
    const attempt = await startAttempt();
    expect(attempt.capability).toMatch(/^\/homeserver-dashboard\/signin\/[0-9a-f]{32}:r$/);
    expect(attempt.verifier.length).toBeGreaterThanOrEqual(43);
    expect(attempt.relay).toBe('https://relay.example/link/');
  });

  describe('session status', () => {
    it('says sign-in is required when there is no session', async () => {
      const response = await getSessionRoute(request('/api/auth/session'));
      expect(await response.json()).toEqual({ authRequired: true, authenticated: false });
    });

    it('does not report a made-up cookie as signed in', async () => {
      const response = await getSessionRoute(request('/api/auth/session', { headers: withCookie('made-up') }));
      expect(await response.json()).toEqual({ authRequired: true, authenticated: false });
    });
  });

  describe('when ADMIN_PUBKEYS is not set', () => {
    beforeEach(() => {
      delete process.env.ADMIN_PUBKEYS;
    });

    it('reports that no sign-in is required and offers none', async () => {
      expect(await (await getSessionRoute(request('/api/auth/session'))).json()).toEqual({ authRequired: false });
      expect((await postChallenge(request('/api/auth/challenge', { method: 'POST' }))).status).toBe(404);
      const response = await login(new Uint8Array(200), 'v');
      expect(response.status).toBe(404);
      expect(sessionCookie(response)).toBeNull();
    });

    it('leaves the admin routes open, as before', async () => {
      expect((await getAdminPassword(request('/api/admin-password'))).status).toBe(200);
    });
  });

  describe('when ADMIN_PUBKEYS is set but unusable', () => {
    beforeEach(() => {
      process.env.ADMIN_PUBKEYS = '';
    });

    it('refuses to sign anyone in and keeps the admin routes closed', async () => {
      expect((await postChallenge(request('/api/auth/challenge', { method: 'POST' }))).status).toBe(503);
      expect((await login(new Uint8Array(200), 'v')).status).toBe(503);
      expect((await getAdminPassword(request('/api/admin-password'))).status).toBe(503);
      expect(await (await getSessionRoute(request('/api/auth/session'))).json()).toMatchObject({
        authRequired: true,
        authenticated: false,
        error: expect.stringContaining('ADMIN_PUBKEYS'),
      });
    });
  });
});
