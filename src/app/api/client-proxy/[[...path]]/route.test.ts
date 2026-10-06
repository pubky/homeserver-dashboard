// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { INERT_CONTENT_HEADERS } from '@/lib/server/inert-content';
import { GET, POST } from './route';

describe('client proxy route', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.CLIENT_BASE_URL = 'http://homeserver:6286';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('proxies GET to the client base URL and forwards query params', async () => {
    const fetchMock = vi
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const request = new NextRequest('http://localhost:8080/api/client-proxy/events/?limit=10');

    const response = await GET(request, { params: Promise.resolve({ path: ['events', ''] }) });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('[]');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://homeserver:6286/events/?limit=10');
  });

  it('relays an HTML file a user uploaded as inert content, never as a live page', async () => {
    const html = '<script>fetch("/api/admin-password")</script>';
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );
    const request = new NextRequest('http://localhost:8080/api/client-proxy/pub/x.html');

    const response = await GET(request, { params: Promise.resolve({ path: ['pub', 'x.html'] }) });

    // The page reads it with fetch, so the body and type pass through...
    expect(await response.text()).toBe(html);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    // ...but a browser sent straight to this address must not run it.
    for (const [name, value] of Object.entries(INERT_CONTENT_HEADERS)) {
      expect(response.headers.get(name)).toBe(value);
    }
  });

  it('reaches the upstream root when no path segments are given', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const request = new NextRequest('http://localhost:8080/api/client-proxy');

    const response = await GET(request, { params: Promise.resolve({}) });

    expect(response.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://homeserver:6286/');
  });

  it('falls back to the compose-internal default base URL', async () => {
    delete process.env.CLIENT_BASE_URL;
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const request = new NextRequest('http://localhost:8080/api/client-proxy/signup');

    await GET(request, { params: Promise.resolve({ path: ['signup'] }) });

    expect(String(fetchMock.mock.calls[0][0])).toBe('http://homeserver:6286/signup');
  });

  it('forwards POST bodies as raw bytes', async () => {
    const bytes = new Uint8Array([0x01, 0x00, 0xfe]);
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const request = new NextRequest('http://localhost:8080/api/client-proxy/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    });

    const response = await POST(request, { params: Promise.resolve({ path: ['signup'] }) });

    expect(response.status).toBe(201);
    const [, init] = fetchMock.mock.calls[0];
    expect(Array.from(new Uint8Array(init?.body as Buffer))).toEqual(Array.from(bytes));
  });

  it('does not follow upstream redirects (a coerced 3xx must not carry headers cross-origin)', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('ok', { status: 200 }));
    const request = new NextRequest('http://localhost:8080/api/client-proxy/events');

    await GET(request, { params: Promise.resolve({ path: ['events'] }) });

    const [, init] = fetchMock.mock.calls[0];
    expect(init?.redirect).toBe('manual');
  });

  it('rejects path segments that resolve to a different origin (SSRF) without fetching', async () => {
    // An encoded `%2F%2F<host>` arrives as a segment containing slashes, so
    // `'/' + join` becomes a protocol-relative `//<host>` that new URL() would
    // resolve to an attacker origin. The proxy must refuse before fetching.
    const fetchMock = vi.spyOn(global, 'fetch');
    const request = new NextRequest('http://localhost:8080/api/client-proxy');

    const response = await GET(request, { params: Promise.resolve({ path: ['//evil.example.com', 'x'] }) });
    const payload = await response.json();

    expect(response.status).toBe(400);
    expect(payload.type).toBe('bad_request');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps abort failures to timeout errors without retrying', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockRejectedValue(new DOMException('Timed out', 'AbortError'));
    const request = new NextRequest('http://localhost:8080/api/client-proxy/events/');

    const response = await GET(request, { params: Promise.resolve({ path: ['events', ''] }) });
    const payload = await response.json();

    expect(response.status).toBe(504);
    expect(payload.type).toBe('timeout');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
