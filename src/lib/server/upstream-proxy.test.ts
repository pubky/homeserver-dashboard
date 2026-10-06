// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INERT_CONTENT_HEADERS, INERT_DOCUMENT_HEADERS } from './inert-content';
import { proxyToUpstream } from './upstream-proxy';

const OPTIONS = { baseUrl: 'http://homeserver:6288', routeName: '/api/test-proxy' };

function expectHeaders(response: Response, headers: Record<string, string>) {
  for (const [name, value] of Object.entries(headers)) expect(response.headers.get(name)).toBe(value);
}

describe('proxyToUpstream', () => {
  afterEach(() => vi.restoreAllMocks());

  it('relays a body someone else wrote as inert content, with its type', async () => {
    const html = '<script>fetch("/api/admin-password")</script>';
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(html, { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );

    const response = await proxyToUpstream(
      new NextRequest('http://localhost/api/x'),
      ['pub', 'x.html'],
      'GET',
      OPTIONS,
    );

    expect(await response.text()).toBe(html);
    expect(response.headers.get('Content-Type')).toBe('text/html');
    expectHeaders(response, INERT_CONTENT_HEADERS);
  });

  it('marks a bodiless upstream answer inert as well', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    const response = await proxyToUpstream(new NextRequest('http://localhost/api/x'), ['x'], 'DELETE', OPTIONS);

    expect(response.status).toBe(204);
    expectHeaders(response, INERT_CONTENT_HEADERS);
  });

  it('marks its own error responses inert', async () => {
    const fetchMock = vi.spyOn(global, 'fetch');

    const response = await proxyToUpstream(new NextRequest('http://localhost/api/x'), ['//evil'], 'GET', OPTIONS);

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expectHeaders(response, INERT_DOCUMENT_HEADERS);
  });
});
