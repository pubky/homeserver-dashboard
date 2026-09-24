import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebDavService } from './webdav';
import type { WebDavError } from './webdav.types';

describe('WebDavService error envelope', () => {
  let service: WebDavService;

  beforeEach(() => {
    service = new WebDavService();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('propagates {error, type} envelope from a 504 timeout response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Homeserver WebDAV request timed out', type: 'timeout', requestId: 'r1' }), {
        status: 504,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    let thrown: WebDavError | null = null;
    try {
      await service.listDirectory('/');
    } catch (err) {
      thrown = err as WebDavError;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.status).toBe(504);
    expect(thrown!.type).toBe('timeout');
    expect(thrown!.message).toBe('Homeserver WebDAV request timed out');
  });

  it('propagates {error, type} envelope from a 502 upstream_error response', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({ error: 'Failed to connect to homeserver WebDAV', type: 'upstream_error', requestId: 'r2' }),
        { status: 502, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    let thrown: WebDavError | null = null;
    try {
      await service.listDirectory('/');
    } catch (err) {
      thrown = err as WebDavError;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.status).toBe(502);
    expect(thrown!.type).toBe('upstream_error');
    expect(thrown!.message).toBe('Failed to connect to homeserver WebDAV');
  });

  it('falls back to status text when the response body has no JSON envelope', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response('upstream html error page', { status: 500 }));

    let thrown: WebDavError | null = null;
    try {
      await service.listDirectory('/');
    } catch (err) {
      thrown = err as WebDavError;
    }

    expect(thrown).not.toBeNull();
    expect(thrown!.status).toBe(500);
    expect(thrown!.type).toBeUndefined();
    expect(thrown!.message).toContain('500');
  });

  it('translates a 404 PROPFIND into an empty directory listing', async () => {
    // Pubky Homeserver lazily creates a user's namespace on first write, so a
    // PROPFIND against a not-yet-created /<pubkey>/pub/ comes back 404. That
    // is "no data yet", not a fault, and the FileBrowser should render the
    // standard empty state, not the red error Alert.
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ error: 'Not Found', type: 'not_found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const directory = await service.listDirectory('/somepubkey/pub/');
    expect(directory.files).toEqual([]);
    expect(directory.path).toBe('/somepubkey/pub/');
  });

  it('sends MOVE via POST with a method override and a proxy-relative Destination', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await service.move('/pk1/pub/old.txt', '/pk1/pub/new.txt');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('/api/webdav/pk1/pub/old.txt');
    expect(init?.method).toBe('POST');
    const headers = new Headers(init?.headers);
    expect(headers.get('X-HTTP-Method-Override')).toBe('MOVE');
    expect(headers.get('Destination')).toBe('/api/webdav/pk1/pub/new.txt');
  });
});
