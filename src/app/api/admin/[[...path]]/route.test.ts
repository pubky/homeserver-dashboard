// @vitest-environment node
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, PATCH } from './route';

describe('admin proxy route', () => {
  const originalEnv = { ...process.env };
  let configDir: string | undefined;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.ADMIN_BASE_URL = 'http://homeserver:6286';
    process.env.ADMIN_TOKEN = 'secret-token';
    // No config.toml to fall back on, whatever this machine has.
    process.env.HOMESERVER_CONFIG_PATH = '/nonexistent/config.toml';
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    if (configDir) await fs.rm(configDir, { recursive: true, force: true });
    configDir = undefined;
  });

  it('returns sanitized config error when env is missing', async () => {
    delete process.env.ADMIN_BASE_URL;
    delete process.env.ADMIN_TOKEN;
    const request = new NextRequest('http://localhost:8080/api/admin/info');

    const response = await GET(request, { params: Promise.resolve({ path: ['info'] }) });
    const payload = await response.json();

    expect(response.status).toBe(500);
    expect(payload.error).toBe('Homeserver admin API is not configured');
    expect(payload).not.toHaveProperty('details');
    expect(payload).not.toHaveProperty('attemptedUrl');
  });

  it("calls the address and sends the password from the homeserver's config.toml when the variables are not set", async () => {
    configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-proxy-'));
    await fs.writeFile(
      path.join(configDir, 'config.toml'),
      '[admin]\nlisten_socket = "127.0.0.1:7777"\nadmin_password = "from-the-config"\n',
    );
    delete process.env.ADMIN_BASE_URL;
    delete process.env.ADMIN_TOKEN;
    process.env.HOMESERVER_CONFIG_PATH = path.join(configDir, 'config.toml');
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response('{}', { status: 200 }));

    const request = new NextRequest('http://localhost:8080/api/admin/info');
    const response = await GET(request, { params: Promise.resolve({ path: ['info'] }) });

    expect(response.status).toBe(200);
    const [urlArg, initArg] = fetchMock.mock.calls[0];
    expect(String(urlArg)).toBe('http://127.0.0.1:7777/info');
    expect((initArg as RequestInit).headers).toEqual(
      expect.objectContaining({ 'X-Admin-Password': 'from-the-config' }),
    );
  });

  it('proxies successful response and forwards query params', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const request = new NextRequest('http://localhost:8080/api/admin/users?limit=20');

    const response = await GET(request, { params: Promise.resolve({ path: ['users'] }) });
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(payload).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [urlArg, initArg] = fetchMock.mock.calls[0];
    expect(String(urlArg)).toContain('/users?limit=20');
    expect((initArg as RequestInit).headers).toEqual(expect.objectContaining({ 'X-Admin-Password': 'secret-token' }));
  });

  it('passes a PATCH and its body through', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    const request = new NextRequest('http://localhost:8080/api/admin/users/pk1/quota', {
      method: 'PATCH',
      body: JSON.stringify({ storage_quota_mb: 10 }),
      headers: { 'content-type': 'application/json' },
    });

    const response = await PATCH(request, { params: Promise.resolve({ path: ['users', 'pk1', 'quota'] }) });

    expect(response.status).toBe(200);
    const [urlArg, initArg] = fetchMock.mock.calls[0];
    expect(String(urlArg)).toContain('/users/pk1/quota');
    expect((initArg as RequestInit).method).toBe('PATCH');
    expect(new TextDecoder().decode((initArg as RequestInit).body as ArrayBuffer)).toBe('{"storage_quota_mb":10}');
  });

  it('maps abort failures to timeout errors', async () => {
    vi.spyOn(global, 'fetch').mockRejectedValue(new DOMException('Timed out', 'AbortError'));
    const request = new NextRequest('http://localhost:8080/api/admin/info');

    const response = await GET(request, { params: Promise.resolve({ path: ['info'] }) });
    const payload = await response.json();

    expect(response.status).toBe(504);
    expect(payload.type).toBe('timeout');
    expect(payload).not.toHaveProperty('baseUrl');
  });

  it('does not retry the upstream fetch when it aborts (timeout)', async () => {
    const fetchMock = vi.spyOn(global, 'fetch').mockRejectedValue(new DOMException('Timed out', 'AbortError'));
    const request = new NextRequest('http://localhost:8080/api/admin/info');

    await GET(request, { params: Promise.resolve({ path: ['info'] }) });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
