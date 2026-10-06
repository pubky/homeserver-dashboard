import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DASHBOARD_REQUEST_HEADER, installDashboardRequestHeader } from './dashboard-request';

describe('installDashboardRequestHeader', () => {
  let sent: { input: RequestInfo | URL; headers: Headers; init?: RequestInit }[];

  beforeEach(() => {
    sent = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        sent.push({ input, init, headers: new Headers(init?.headers) });
        return new Response(null);
      }),
    );
    installDashboardRequestHeader();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const headerOf = (index = 0) => sent[index].headers.get(DASHBOARD_REQUEST_HEADER);

  it.each([
    ['a relative path', '/api/admin/info'],
    ['an absolute URL on this origin', `${window.location.origin}/api/logs?lines=5`],
    ['a URL object', new URL('/api/server-config', window.location.origin)],
    ['a Request object', new Request(`${window.location.origin}/api/webdav/x`)],
  ])('marks a request to the own API given as %s', async (_case, input) => {
    await fetch(input);
    expect(headerOf()).toBe('1');
  });

  it('keeps the headers and options the caller set', async () => {
    await fetch('/api/server-config', {
      method: 'POST',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(sent[0].init).toMatchObject({ method: 'POST', cache: 'no-store', body: '{}' });
    expect(sent[0].headers.get('content-type')).toBe('application/json');
    expect(headerOf()).toBe('1');
  });

  it('keeps the headers of a Request object', async () => {
    await fetch(new Request(`${window.location.origin}/api/x`, { headers: { depth: '1' } }));
    expect(sent[0].headers.get('depth')).toBe('1');
    expect(headerOf()).toBe('1');
  });

  it.each([
    ['another origin', 'https://httprelay.pubky.app/link/abc'],
    ['another origin with an /api/ path', 'https://evil.test/api/admin/info'],
    ['a page of this site outside /api/', '/dashboard'],
    ['a path that only starts like /api', '/apiary'],
  ])('leaves a request to %s untouched', async (_case, input) => {
    const init = { headers: { accept: 'text/plain' } };
    await fetch(input, init);
    expect(headerOf()).toBeNull();
    expect(sent[0].init).toBe(init);
  });

  it('installs once, however often it is called', async () => {
    const installed = window.fetch;
    installDashboardRequestHeader();
    installDashboardRequestHeader();
    expect(window.fetch).toBe(installed);
    await fetch('/api/health');
    expect(sent).toHaveLength(1);
  });
});
