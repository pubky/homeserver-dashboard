// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INERT_CONTENT_HEADERS } from '@/lib/server/inert-content';
import { proxyWebDavRequest } from './utils';

describe('webdav proxy utils', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ADMIN_BASE_URL = 'http://homeserver:6286';
    process.env.ADMIN_TOKEN = 'secret-token';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('returns sanitized config error when env is missing', async () => {
    delete process.env.ADMIN_BASE_URL;
    delete process.env.ADMIN_TOKEN;

    const request = new NextRequest('http://localhost:8080/api/webdav');
    const response = await proxyWebDavRequest(request, Promise.resolve({ path: [] }), 'GET');
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toBe('WebDAV proxy is not configured');
    expect(payload).not.toHaveProperty('details');
  });

  it('rejects unsupported method override', async () => {
    const request = new NextRequest('http://localhost:8080/api/webdav/test', {
      method: 'POST',
      headers: {
        'X-HTTP-Method-Override': 'TRACE',
      },
    });

    const response = await proxyWebDavRequest(request, Promise.resolve({ path: ['test'] }), 'POST');
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.type).toBe('bad_request');
  });

  it.each([
    [['..'], 'parent segment'],
    [['user', '..', '..', 'etc'], 'mid-path parent'],
    [['.'], 'current-dir segment'],
    [['foo\0bar'], 'null byte'],
    [['foo/bar'], 'embedded slash'],
    [['foo\\bar'], 'embedded backslash'],
  ])('rejects path with %s (%s)', async (path) => {
    const fetchMock = vi.spyOn(global, 'fetch');
    const request = new NextRequest('http://localhost:8080/api/webdav/' + path.join('/'));
    const response = await proxyWebDavRequest(request, Promise.resolve({ path }), 'GET');
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.type).toBe('bad_request');
    expect(payload.error).toBe('Invalid path segment');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not retry the upstream fetch when it aborts (timeout)', async () => {
    // Timeouts mean the upstream is slow or unreachable; retrying with the same
    // AbortSignal would just throw again instantly and burn budget for no gain.
    const fetchMock = vi.spyOn(global, 'fetch').mockRejectedValue(new DOMException('Timed out', 'AbortError'));
    const request = new NextRequest('http://localhost:8080/api/webdav/user/pub/', {
      method: 'POST',
      headers: { 'X-HTTP-Method-Override': 'PROPFIND', Depth: '1' },
    });

    const response = await proxyWebDavRequest(request, Promise.resolve({ path: ['user', 'pub'] }), 'POST');
    const payload = await response.json();

    expect(response.status).toBe(504);
    expect(payload.type).toBe('timeout');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([['MOVE'], ['COPY']])(
    'rewrites the %s Destination header from the proxy path to the upstream /dav URL',
    async (davMethod) => {
      const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
      const request = new NextRequest('http://localhost:8080/api/webdav/pk1/pub/old.txt', {
        method: 'POST',
        headers: {
          'X-HTTP-Method-Override': davMethod,
          Destination: '/api/webdav/pk1/pub/new.txt',
        },
      });

      const response = await proxyWebDavRequest(request, Promise.resolve({ path: ['pk1', 'pub', 'old.txt'] }), 'POST');

      expect(response.status).toBe(201);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(String(url)).toBe('http://homeserver:6286/dav/pk1/pub/old.txt');
      expect(init?.method).toBe(davMethod);
      const headers = new Headers(init?.headers as HeadersInit);
      expect(headers.get('Destination')).toBe('http://homeserver:6286/dav/pk1/pub/new.txt');
    },
  );

  it('rewrites an absolute-URL Destination against the upstream base', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const request = new NextRequest('http://localhost:8080/api/webdav/pk1/pub/a.txt', {
      method: 'POST',
      headers: {
        'X-HTTP-Method-Override': 'MOVE',
        Destination: 'http://localhost:8080/api/webdav/pk1/pub/b.txt',
      },
    });

    const response = await proxyWebDavRequest(request, Promise.resolve({ path: ['pk1', 'pub', 'a.txt'] }), 'POST');

    expect(response.status).toBe(204);
    const [, init] = fetchMock.mock.calls[0];
    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get('Destination')).toBe('http://homeserver:6286/dav/pk1/pub/b.txt');
  });

  it('round-trips binary bodies without corruption', async () => {
    const uploaded = new Uint8Array([0x50, 0x4b, 0x00, 0x03, 0xff, 0x00, 0x7f]);
    const downloaded = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x1a, 0xff]);
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(downloaded, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }),
      );

    const request = new NextRequest('http://localhost:8080/api/webdav/pk1/pub/bin.dat', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: uploaded,
    });

    const response = await proxyWebDavRequest(request, Promise.resolve({ path: ['pk1', 'pub', 'bin.dat'] }), 'PUT');

    const [, init] = fetchMock.mock.calls[0];
    const sentBody = new Uint8Array(init?.body as Buffer);
    expect(Array.from(sentBody)).toEqual(Array.from(uploaded));

    expect(response.status).toBe(200);
    const received = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(received)).toEqual(Array.from(downloaded));
  });

  it('relays an HTML file a user uploaded as inert content, never as a live page', async () => {
    const html = '<script>fetch("/api/admin-password")</script>';
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );
    const request = new NextRequest('http://localhost:8080/api/webdav/user/pub/x.html');

    const response = await proxyWebDavRequest(request, Promise.resolve({ path: ['user', 'pub', 'x.html'] }), 'GET');

    expect(await response.text()).toBe(html);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    for (const [name, value] of Object.entries(INERT_CONTENT_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it('marks a bodiless WebDAV answer inert as well', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const request = new NextRequest('http://localhost:8080/api/webdav/user/pub/x.html', { method: 'DELETE' });

    const response = await proxyWebDavRequest(request, Promise.resolve({ path: ['user', 'pub', 'x.html'] }), 'DELETE');

    expect(response.status).toBe(204);
    for (const [name, value] of Object.entries(INERT_CONTENT_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it('proxies PROPFIND responses successfully', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('<multistatus />', {
        status: 207,
        headers: { 'Content-Type': 'application/xml' },
      }),
    );

    const request = new NextRequest('http://localhost:8080/api/webdav/user/pub', {
      method: 'POST',
      headers: {
        'X-HTTP-Method-Override': 'PROPFIND',
        Depth: '1',
      },
    });

    const response = await proxyWebDavRequest(request, Promise.resolve({ path: ['user', 'pub'] }), 'POST');
    const body = await response.text();

    expect(response.status).toBe(207);
    expect(body).toContain('multistatus');
    expect(response.headers.get('X-Request-Id')).toBeTruthy();
  });
});
