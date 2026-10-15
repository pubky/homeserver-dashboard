// @vitest-environment node
import { NextRequest, NextResponse } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, hasValidSession, isPasswordCorrect, setSessionCookie, withSession } from './session';

function issuedCookie(): string {
  const response = new NextResponse(null);
  setSessionCookie(response);
  return response.cookies.get(SESSION_COOKIE)?.value ?? '';
}

function request(cookie?: string): NextRequest {
  return new NextRequest('http://localhost:8080/api/x', {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${cookie}` } : {},
  });
}

describe('session', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('without DASHBOARD_PASSWORD', () => {
    it('lets every request through and accepts no password', () => {
      vi.stubEnv('DASHBOARD_PASSWORD', '');
      expect(hasValidSession(undefined)).toBe(true);
      expect(isPasswordCorrect('')).toBe(false);
      expect(isPasswordCorrect('anything')).toBe(false);
    });

    it('sets no cookie', () => {
      vi.stubEnv('DASHBOARD_PASSWORD', '');
      expect(issuedCookie()).toBe('');
    });
  });

  describe('with DASHBOARD_PASSWORD', () => {
    it('checks the password', () => {
      vi.stubEnv('DASHBOARD_PASSWORD', 'secret');
      expect(isPasswordCorrect('secret')).toBe(true);
      expect(isPasswordCorrect('secre')).toBe(false);
      expect(isPasswordCorrect('')).toBe(false);
    });

    it('accepts only the cookie it issued', () => {
      vi.stubEnv('DASHBOARD_PASSWORD', 'secret');
      const cookie = issuedCookie();
      expect(cookie).not.toContain('secret');
      expect(hasValidSession(cookie)).toBe(true);
      expect(hasValidSession(undefined)).toBe(false);
      expect(hasValidSession('secret')).toBe(false);
      expect(hasValidSession(`${cookie}0`)).toBe(false);
    });

    it('issues an http-only, same-site cookie', () => {
      vi.stubEnv('DASHBOARD_PASSWORD', 'secret');
      const response = new NextResponse(null);
      setSessionCookie(response);
      const header = response.headers.get('set-cookie') ?? '';
      expect(header).toContain('HttpOnly');
      expect(header).toMatch(/SameSite=strict/i);
      expect(header).toContain('Path=/');
    });

    it('ends sessions when the password changes', () => {
      vi.stubEnv('DASHBOARD_PASSWORD', 'secret');
      const cookie = issuedCookie();
      vi.stubEnv('DASHBOARD_PASSWORD', 'rotated');
      expect(hasValidSession(cookie)).toBe(false);
    });
  });

  describe('withSession', () => {
    const handler = vi.fn(async () => NextResponse.json({ ok: true }));

    it('answers 401 without a valid session and skips the handler', async () => {
      vi.stubEnv('DASHBOARD_PASSWORD', 'secret');
      handler.mockClear();
      const response = await withSession(handler)(request('nope'));
      expect(response.status).toBe(401);
      expect((await response.json()).type).toBe('unauthorized');
      expect(handler).not.toHaveBeenCalled();
    });

    it('calls the handler with a valid session', async () => {
      vi.stubEnv('DASHBOARD_PASSWORD', 'secret');
      const response = await withSession(handler)(request(issuedCookie()));
      expect(response.status).toBe(200);
    });

    it('calls the handler when no password is configured', async () => {
      vi.stubEnv('DASHBOARD_PASSWORD', '');
      const response = await withSession(handler)(request());
      expect(response.status).toBe(200);
    });
  });
});
