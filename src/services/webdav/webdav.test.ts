import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebDavService, decodedPath } from './webdav';
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

  it('names an entry by its decoded href when the homeserver sends no displayname', async () => {
    const entry = (href: string) =>
      `<D:response><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype/></D:prop></D:propstat></D:response>`;
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(
        `<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">${entry('/dav/pk1/pub/')}${entry('/dav/pk1/pub/made%20by%20admin.txt')}${entry('/dav/pk1/pub/100%.txt')}</D:multistatus>`,
        { status: 207, headers: { 'Content-Type': 'application/xml' } },
      ),
    );

    const directory = await service.listDirectory('/pk1/pub/');

    expect(directory.files.map(({ displayName, path }) => ({ displayName, path }))).toEqual([
      // Not valid percent-encoding: shown as the homeserver sent it.
      { displayName: '100%.txt', path: '/pk1/pub/100%.txt' },
      // The path keeps its encoding: it is what later requests send.
      { displayName: 'made by admin.txt', path: '/pk1/pub/made%20by%20admin.txt' },
    ]);
  });
});

describe('decodedPath', () => {
  it('decodes each name and keeps the slashes', () => {
    expect(decodedPath('/pk1/pub/my%20folder/caf%C3%A9.txt')).toBe('/pk1/pub/my folder/café.txt');
    expect(decodedPath('/pk1/pub/')).toBe('/pk1/pub/');
  });

  it('leaves a name that is not valid percent-encoding as it was sent', () => {
    expect(decodedPath('/pk1/pub/100%/x%20y')).toBe('/pk1/pub/100%/x y');
  });
});
