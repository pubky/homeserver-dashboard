// @vitest-environment node
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AdminService } from './admin';

const jsonHeaders = { 'Content-Type': 'application/json' };

describe('AdminService', () => {
  let service: AdminService;
  let fetchMock: Mock;

  beforeEach(() => {
    service = new AdminService();
    fetchMock = vi.spyOn(global, 'fetch') as unknown as Mock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('getInfo requests /api/admin/info with JSON content type and no-store', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ version: '1.0.0' }), { status: 200, headers: jsonHeaders }),
    );
    const info = await service.getInfo();
    expect(info.version).toBe('1.0.0');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/info');
    expect(init.cache).toBe('no-store');
    expect((init.headers as Headers).get('content-type')).toBe('application/json');
  });

  it('getDisabledUsers builds the limit/cursor query', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ users: [] }), { status: 200, headers: jsonHeaders }));
    await service.getDisabledUsers(5, 'abc');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/users/disabled?limit=5&cursor=abc');
  });

  it('generateInvite asks with GET by default and posts limits when given', async () => {
    fetchMock.mockImplementation(
      async () => new Response(JSON.stringify({ token: 'AAAA-BBBB' }), { status: 200, headers: jsonHeaders }),
    );
    await expect(service.generateInvite()).resolves.toEqual({ token: 'AAAA-BBBB' });
    expect(fetchMock.mock.calls[0][1].method).toBeUndefined();
    await service.generateInvite({});
    expect(fetchMock.mock.calls[1][1].method).toBeUndefined();
    await service.generateInvite({ storage_quota_mb: 500 });
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toBe('/api/admin/generate_signup_token');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ storage_quota_mb: 500 });
  });

  it("generateInvite surfaces the route's message", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ type: 'upstream_error', error: 'Invalid rate' }), {
        status: 422,
        headers: jsonHeaders,
      }),
    );
    await expect(service.generateInvite({ rate_read: '10mb' })).rejects.toThrow('Invalid rate');
  });

  it('getSignupTokens passes state, limit and cursor', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ items: [], next_cursor: null }), { status: 200, headers: jsonHeaders }),
    );
    await expect(service.getSignupTokens('used', 20, 'AAAA-BBBB-CCCC')).resolves.toEqual({
      items: [],
      next_cursor: null,
    });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/signup_tokens?state=used&limit=20&cursor=AAAA-BBBB-CCCC');
  });

  it('surfaces the JSON error message and status on failure', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Invalid admin password' }), { status: 401, headers: jsonHeaders }),
    );
    const error = await service.getInfo().catch((e) => e);
    expect(error.message).toBe('Invalid admin password');
    expect(error.status).toBe(401);
  });

  it('prefers a JSON "message" field when present', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ message: 'try later' }), { status: 503, headers: jsonHeaders }),
    );
    await expect(service.getInfo()).rejects.toThrow('try later');
  });

  it('uses plain-text error bodies but never HTML error pages', async () => {
    fetchMock.mockResolvedValue(new Response('upstream exploded', { status: 502 }));
    await expect(service.getInfo()).rejects.toThrow('upstream exploded');

    fetchMock.mockResolvedValue(new Response('<!DOCTYPE html><html>nope</html>', { status: 502 }));
    await expect(service.getInfo()).rejects.toThrow('Request failed: 502');
  });

  it('disableUser posts to the disable endpoint', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await expect(service.disableUser({ pubkey: 'pk1' })).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/users/pk1/disable');
    expect(init.method).toBe('POST');
  });

  it('treats the homeserver\'s plain-text "Ok" as success (disable/enable answer that way)', async () => {
    fetchMock.mockResolvedValue(new Response('Ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }));
    await expect(service.disableUser({ pubkey: 'pk1' })).resolves.toBeUndefined();
    await expect(service.enableUser({ pubkey: 'pk1' })).resolves.toBeUndefined();
  });

  it('disableUser and enableUser still fail on a non-2xx plain-text answer', async () => {
    fetchMock.mockImplementation(async () => new Response('user not found', { status: 404 }));
    await expect(service.disableUser({ pubkey: 'pk1' })).rejects.toThrow('user not found');
    await expect(service.enableUser({ pubkey: 'pk1' })).rejects.toThrow('user not found');
  });

  it('still rejects a 2xx answer that is not JSON where JSON is expected', async () => {
    fetchMock.mockResolvedValue(new Response('<html>interstitial</html>', { status: 200 }));
    await expect(service.getInfo()).rejects.toThrow();
  });

  it('enableUser posts to the enable endpoint', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await service.enableUser({ pubkey: 'pk2' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/admin/users/pk2/enable');
  });

  it('deleteUrl issues a DELETE through the webdav proxy path', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await service.deleteUrl({ path: 'pub/files/a.txt' });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/admin/webdav/pub/files/a.txt');
    expect(init.method).toBe('DELETE');
  });

  it('wraps a non-Error rejection in a network error', async () => {
    fetchMock.mockRejectedValue('connection reset');
    await expect(service.getInfo()).rejects.toThrow('Network error: Failed to connect to homeserver');
  });

  it('rethrows Error rejections untouched', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(service.getInfo()).rejects.toThrow('fetch failed');
  });

  describe('generateInvite', () => {
    it('returns the token from the signup-token route', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ token: 'INV-1' }), { status: 200, headers: jsonHeaders }),
      );
      await expect(service.generateInvite()).resolves.toEqual({ token: 'INV-1' });
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/admin/generate_signup_token');
      expect(init.cache).toBe('no-store');
    });

    it('surfaces the JSON error on failure', async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ error: 'No invites left' }), { status: 429, headers: jsonHeaders }),
      );
      await expect(service.generateInvite()).rejects.toThrow('No invites left');
    });

    it('falls back to a status message when the error body is not JSON', async () => {
      fetchMock.mockResolvedValue(new Response('boom', { status: 500 }));
      await expect(service.generateInvite()).rejects.toThrow('Failed to generate invite: 500');
    });
  });
});
