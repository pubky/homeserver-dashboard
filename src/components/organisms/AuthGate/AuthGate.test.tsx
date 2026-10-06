import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate, useAdminSession } from './AuthGate';

// Stand-in for Pubky Ring and the relay: the flow "returns" a signed token as
// soon as the test lets it.
const ring = vi.hoisted(() => ({
  approve: null as null | ((bytes: Uint8Array) => void),
  startedWith: null as null | { capability: string; relay: unknown },
}));

vi.mock('@synonymdev/pubky', () => ({
  AuthFlowKind: { signin: () => 'signin' },
  Pubky: class {
    startCookieAuthFlow(capability: string, _kind: unknown, relay: unknown) {
      ring.startedWith = { capability, relay };
      return {
        authorizationUrl: `pubkyauth://signin?caps=${capability}`,
        awaitToken: () =>
          new Promise((resolve) => {
            ring.approve = (bytes) => resolve({ toBytes: () => bytes });
          }),
      };
    }
  },
}));

type Reply = { status?: number; body?: unknown };

/** Routes fetch calls by "METHOD path" to canned replies, and records them. */
function mockFetch(replies: Record<string, Reply | (() => Reply)>) {
  const calls: { key: string; body?: string }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(input)}`;
    calls.push({ key, body: typeof init?.body === 'string' ? init.body : undefined });
    const entry = replies[key];
    if (!entry) throw new Error(`unexpected fetch: ${key}`);
    const { status = 200, body } = typeof entry === 'function' ? entry() : entry;
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function Dashboard() {
  const session = useAdminSession();
  return (
    <div data-testid="dashboard">
      {session ? `signed in as ${session.pubky}` : 'no sign-in'}
      {session && <button onClick={() => void session.signOut()}>Sign out</button>}
    </div>
  );
}

const renderGate = () =>
  render(
    <AuthGate>
      <Dashboard />
    </AuthGate>,
  );

const CHALLENGE = {
  capability: '/homeserver-dashboard/signin/0123456789abcdef0123456789abcdef:r',
  verifier: 'the-verifier',
  relay: null,
  expiresInSecs: 300,
};

describe('AuthGate', () => {
  beforeEach(() => {
    ring.approve = null;
    ring.startedWith = null;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows the dashboard straight away when the server asks for no sign-in', async () => {
    mockFetch({ 'GET /api/auth/session': { body: { authRequired: false } } });
    renderGate();
    expect((await screen.findByTestId('dashboard')).textContent).toBe('no sign-in');
  });

  it('shows the dashboard to a signed-in admin', async () => {
    mockFetch({ 'GET /api/auth/session': { body: { authRequired: true, authenticated: true, pubky: 'abc' } } });
    renderGate();
    expect((await screen.findByTestId('dashboard')).textContent).toContain('signed in as abc');
  });

  it('does not render the dashboard before the server has answered', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    );
    renderGate();
    expect(screen.queryByTestId('dashboard')).toBeNull();
    expect(screen.getByTestId('auth-loading')).toBeTruthy();
  });

  it.each([
    ['the status request fails', () => ({ status: 500 })],
    [
      'the server says sign-in is misconfigured',
      () => ({ body: { authRequired: true, error: 'ADMIN_PUBKEYS is bad' } }),
    ],
    ['the answer claims a session but names no admin', () => ({ body: { authRequired: true, authenticated: true } })],
    ['the answer is an empty object', () => ({ body: {} })],
  ])('keeps the dashboard closed when %s', async (_case, reply) => {
    mockFetch({ 'GET /api/auth/session': reply, 'POST /api/auth/challenge': { status: 503, body: { error: 'x' } } });
    renderGate();
    await waitFor(() => expect(screen.queryByTestId('auth-loading')).toBeNull());
    expect(screen.queryByTestId('dashboard')).toBeNull();
  });

  it('signs in through Ring: sends the signed token with the verifier, then shows the dashboard', async () => {
    let signedIn = false;
    const calls = mockFetch({
      'GET /api/auth/session': () => ({
        body: signedIn
          ? { authRequired: true, authenticated: true, pubky: 'admin-key' }
          : { authRequired: true, authenticated: false },
      }),
      'POST /api/auth/challenge': { body: CHALLENGE },
      'POST /api/auth/login': () => {
        signedIn = true;
        return { body: { pubky: 'admin-key' } };
      },
    });
    renderGate();

    await screen.findByTestId('sign-in-qr');
    expect(screen.queryByTestId('dashboard')).toBeNull();
    expect(ring.startedWith).toEqual({ capability: CHALLENGE.capability, relay: null });

    ring.approve!(new Uint8Array([1, 2, 3, 250]));
    expect((await screen.findByTestId('dashboard')).textContent).toContain('signed in as admin-key');

    const login = calls.find((call) => call.key === 'POST /api/auth/login');
    expect(JSON.parse(login!.body!)).toEqual({ token: 'AQID+g==', verifier: 'the-verifier' });
  });

  it('shows why a sign-in was refused and offers another try', async () => {
    const calls = mockFetch({
      'GET /api/auth/session': { body: { authRequired: true, authenticated: false } },
      'POST /api/auth/challenge': { body: CHALLENGE },
      'POST /api/auth/login': { status: 403, body: { error: 'This pubky is not an admin of this dashboard' } },
    });
    renderGate();
    await screen.findByTestId('sign-in-qr');
    ring.approve!(new Uint8Array([9]));

    expect((await screen.findByTestId('sign-in-error')).textContent).toContain('not an admin');
    expect(screen.queryByTestId('dashboard')).toBeNull();

    fireEvent.click(screen.getByText('Try again'));
    await screen.findByTestId('sign-in-qr');
    expect(calls.filter((call) => call.key === 'POST /api/auth/challenge')).toHaveLength(2);
  });

  it("cancels the attempt's time limit once signed in", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let signedIn = false;
      mockFetch({
        'GET /api/auth/session': () => ({
          body: signedIn
            ? { authRequired: true, authenticated: true, pubky: 'admin-key' }
            : { authRequired: true, authenticated: false },
        }),
        'POST /api/auth/challenge': { body: CHALLENGE },
        'POST /api/auth/login': () => {
          signedIn = true;
          return { body: { pubky: 'admin-key' } };
        },
      });
      renderGate();
      await screen.findByTestId('sign-in-qr');
      ring.approve!(new Uint8Array([1]));
      await screen.findByTestId('dashboard');

      // The time limit was cancelled, not left to run out: the only timer
      // still pending is the gate's own periodic session check.
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('gives up on an attempt nobody approves, and offers another', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      mockFetch({
        'GET /api/auth/session': { body: { authRequired: true, authenticated: false } },
        'POST /api/auth/challenge': { body: CHALLENGE },
      });
      renderGate();
      await screen.findByTestId('sign-in-qr');

      await vi.advanceTimersByTimeAsync(CHALLENGE.expiresInSecs * 1000 + 1);
      expect((await screen.findByTestId('sign-in-error')).textContent).toContain('expired');
      expect(screen.getByText('Try again')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns to the sign-in after signing out', async () => {
    let signedIn = true;
    const calls = mockFetch({
      'GET /api/auth/session': () => ({
        body: signedIn
          ? { authRequired: true, authenticated: true, pubky: 'admin-key' }
          : { authRequired: true, authenticated: false },
      }),
      'DELETE /api/auth/session': () => {
        signedIn = false;
        return { status: 204 };
      },
      'POST /api/auth/challenge': { body: CHALLENGE },
    });
    renderGate();
    fireEvent.click(await screen.findByText('Sign out'));

    await screen.findByTestId('sign-in');
    expect(screen.queryByTestId('dashboard')).toBeNull();
    expect(calls.some((call) => call.key === 'DELETE /api/auth/session')).toBe(true);
  });

  it('closes the dashboard when a later check finds the session has ended', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let alive = true;
      mockFetch({
        'GET /api/auth/session': () => ({
          body: alive
            ? { authRequired: true, authenticated: true, pubky: 'admin-key' }
            : { authRequired: true, authenticated: false },
        }),
        'POST /api/auth/challenge': { body: CHALLENGE },
      });
      renderGate();
      await screen.findByTestId('dashboard');

      alive = false;
      await vi.advanceTimersByTimeAsync(31_000);
      await screen.findByTestId('sign-in');
      expect(screen.queryByTestId('dashboard')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
