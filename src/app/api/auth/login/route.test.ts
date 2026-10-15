// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, hasValidSession } from '@/lib/server/session';
import { POST } from './route';

function login(body: string): NextRequest {
  return new NextRequest('http://localhost:8080/api/auth/login', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  });
}

describe('login route', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('answers 404 when the dashboard has no password', async () => {
    vi.stubEnv('DASHBOARD_PASSWORD', '');
    const response = await POST(login(JSON.stringify({ password: 'x' })));
    expect(response.status).toBe(404);
  });

  it('rejects a wrong password without a cookie', async () => {
    vi.stubEnv('DASHBOARD_PASSWORD', 'secret');
    const response = await POST(login(JSON.stringify({ password: 'wrong' })));
    expect(response.status).toBe(401);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('rejects a body that is not a password object', async () => {
    vi.stubEnv('DASHBOARD_PASSWORD', 'secret');
    expect((await POST(login('not json'))).status).toBe(401);
    expect((await POST(login(JSON.stringify({ password: 42 })))).status).toBe(401);
  });

  it('sets a valid session cookie for the right password', async () => {
    vi.stubEnv('DASHBOARD_PASSWORD', 'secret');
    const response = await POST(login(JSON.stringify({ password: 'secret' })));
    expect(response.status).toBe(204);
    expect(hasValidSession(response.cookies.get(SESSION_COOKIE)?.value)).toBe(true);
  });
});
