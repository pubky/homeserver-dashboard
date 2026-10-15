// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import * as serverConfigRoute from './route';

const VALID_CONFIG = [
  '[general]',
  'database_url = "postgres://localhost:5432/pubky_homeserver"',
  'signup_mode = "token_required"',
  '',
  '[drive]',
  'pubky_listen_socket = "127.0.0.1:6287"',
  'icann_listen_socket = "127.0.0.1:6286"',
  '',
  '[admin]',
  'enabled = true',
  'listen_socket = "127.0.0.1:6288"',
  'admin_password = "real-admin-password"',
  '',
  '[storage]',
  'type = "file_system"',
  '',
].join('\n');

function sha256(s: string): string {
  return 'sha256:' + createHash('sha256').update(s).digest('hex');
}

describe('server-config route', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'srv-config-test-'));
    configPath = path.join(tmpDir, 'config.toml');
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // The route reads HOMESERVER_CONFIG_PATH lazily (per request), so tests
  // just set the env var; no module-registry tricks needed.
  function loadRoute() {
    process.env.HOMESERVER_CONFIG_PATH = configPath;
    return serverConfigRoute;
  }

  function getRequest(): NextRequest {
    return new NextRequest('http://localhost:8080/api/server-config');
  }

  function postRequest(body: unknown): NextRequest {
    return new NextRequest('http://localhost:8080/api/server-config', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    });
  }

  describe('GET', () => {
    it('returns 404 when the config file does not exist', async () => {
      const { GET } = await loadRoute();
      const response = await GET(getRequest());
      const payload = await response.json();
      expect(response.status).toBe(404);
      expect(payload.type).toBe('not_found');
    });

    it('returns config + checksum + mtime + writable', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const { GET } = await loadRoute();
      const response = await GET(getRequest());
      const payload = await response.json();
      expect(response.status).toBe(200);
      expect(payload).toMatchObject({
        config: expect.stringContaining('[general]'),
        checksum: sha256(VALID_CONFIG),
        writable: true,
      });
      expect(typeof payload.mtime).toBe('string');
      expect(new Date(payload.mtime).getTime()).not.toBeNaN();
    });

    it('redacts admin_password and database_url', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const { GET } = await loadRoute();
      const payload = await (await GET(getRequest())).json();
      expect(payload.config).not.toContain('real-admin-password');
      expect(payload.config).not.toContain('postgres://localhost:5432');
      expect(payload.config).toContain('"********"');
    });

    it('returns writable:false on a read-only config file with a usable errno', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      await fs.chmod(configPath, 0o444);
      const { GET } = await loadRoute();
      const payload = await (await GET(getRequest())).json();
      expect(payload.writable).toBe(false);
      // Diagnostics let an operator debug a stuck Read-only badge from browser
      // dev tools without SSH access.
      expect(payload.diagnostics).toMatchObject({
        process: { uid: expect.any(Number), gid: expect.any(Number) },
        file: { path: expect.any(String), uid: expect.any(Number), gid: expect.any(Number), mode: '0444' },
        writable_error: expect.stringMatching(/^E/),
      });
    });

    it('exposes process uid/gid and file uid/gid/mode under diagnostics', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      await fs.chmod(configPath, 0o660);
      const { GET } = await loadRoute();
      const payload = await (await GET(getRequest())).json();
      expect(payload.diagnostics.file.mode).toBe('0660');
      expect(payload.diagnostics.process.uid).toBe(process.getuid?.() ?? null);
      expect(payload.diagnostics.writable_error).toBeUndefined();
    });

    it('returns 500 internal_error on unexpected fs failure', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const { GET } = await loadRoute();
      // Both opens (r+ and the read-only fallback) fail. The route catches and
      // maps to a sanitised 500 - we do not leak the underlying error message.
      vi.spyOn(fs, 'open').mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      const response = await GET(getRequest());
      const payload = await response.json();
      expect(response.status).toBe(500);
      expect(payload.type).toBe('internal_error');
      expect(payload).not.toHaveProperty('details');
    });
  });

  describe('POST', () => {
    it('rejects invalid JSON body with 400', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const { POST } = await loadRoute();
      const response = await POST(postRequest('{not-json'));
      const payload = await response.json();
      expect(response.status).toBe(400);
      expect(payload.type).toBe('bad_request');
    });

    it('rejects missing config_toml with 400', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const { POST } = await loadRoute();
      const response = await POST(postRequest({ checksum: 'sha256:abc' }));
      expect(response.status).toBe(400);
    });

    it('rejects missing checksum with 400', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const { POST } = await loadRoute();
      const response = await POST(postRequest({ config_toml: VALID_CONFIG }));
      expect(response.status).toBe(400);
    });

    it('returns 404 when the config file does not exist', async () => {
      const { POST } = await loadRoute();
      const response = await POST(postRequest({ config_toml: VALID_CONFIG, checksum: 'sha256:abc' }));
      const payload = await response.json();
      expect(response.status).toBe(404);
      expect(payload.type).toBe('not_found');
    });

    it('returns 409 on checksum mismatch with current_checksum in body', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const { POST } = await loadRoute();
      const response = await POST(
        postRequest({
          config_toml: VALID_CONFIG.replace('token_required', 'open'),
          checksum: 'sha256:wrong',
        }),
      );
      const payload = await response.json();
      expect(response.status).toBe(409);
      expect(payload.type).toBe('conflict');
      expect(payload.current_checksum).toBe(sha256(VALID_CONFIG));
    });

    it('rejects invalid TOML with 400', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const { POST } = await loadRoute();
      const response = await POST(
        postRequest({
          config_toml: 'this is not toml [[[',
          checksum: sha256(VALID_CONFIG),
        }),
      );
      const payload = await response.json();
      expect(response.status).toBe(400);
      expect(payload.error).toContain('Invalid TOML');
    });

    it('rejects config missing a required section with 400', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const { POST } = await loadRoute();
      // No [storage] section
      const broken = ['[general]', '[drive]', '[admin]', 'admin_password = "real-admin-password"'].join('\n');
      const response = await POST(postRequest({ config_toml: broken, checksum: sha256(VALID_CONFIG) }));
      const payload = await response.json();
      expect(response.status).toBe(400);
      expect(payload.error).toContain('storage');
    });

    it('writes the new config atomically and returns the new checksum', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const updated = VALID_CONFIG.replace('token_required', 'open');
      const { POST } = await loadRoute();
      const response = await POST(postRequest({ config_toml: updated, checksum: sha256(VALID_CONFIG) }));
      const payload = await response.json();
      expect(response.status).toBe(200);
      expect(payload.ok).toBe(true);
      expect(payload.checksum).toBe(sha256(updated));
      expect(await fs.readFile(configPath, 'utf-8')).toBe(updated);
    });

    it('save message is platform-aware: generic on standalone, Umbrel-specific on Umbrel', async () => {
      const save = async () => {
        await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
        const updated = VALID_CONFIG.replace('token_required', 'open');
        const { POST } = await loadRoute();
        return (await POST(postRequest({ config_toml: updated, checksum: sha256(VALID_CONFIG) }))).json();
      };
      // This is the one always-visible restart-bearing route (Config tab is not
      // Cloudflare-gated), so its standalone copy must not mention Umbrel.
      process.env.PLATFORM = 'standalone';
      const standalone = await save();
      expect(standalone.message).toContain('Restart your homeserver');
      expect(standalone.message).not.toContain('Umbrel');

      process.env.PLATFORM = 'umbrel';
      const umbrel = await save();
      expect(umbrel.message).toContain('from Umbrel');
    });

    it('preserves the file mode across a save (config.toml holds admin_password)', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      await fs.chmod(configPath, 0o660);
      const updated = VALID_CONFIG.replace('token_required', 'open');
      const { POST } = await loadRoute();
      const response = await POST(postRequest({ config_toml: updated, checksum: sha256(VALID_CONFIG) }));
      expect(response.status).toBe(200);
      const stat = await fs.stat(configPath);
      expect(stat.mode & 0o777).toBe(0o660);
    });

    it('redaction roundtrip: "********" in payload preserves the real on-disk secret', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const { GET, POST } = await loadRoute();
      // What the UI would see in GET - admin_password is masked
      const redactedView = (await (await GET(getRequest())).json()).config as string;
      expect(redactedView).toContain('admin_password = "********"');
      expect(redactedView).not.toContain('real-admin-password');

      // User edits an unrelated line and POSTs the redacted view back
      const userEdit = redactedView.replace('token_required', 'open');
      const response = await POST(postRequest({ config_toml: userEdit, checksum: sha256(VALID_CONFIG) }));
      expect(response.status).toBe(200);

      // The file on disk must still have the real secret, not the "********"
      const onDisk = await fs.readFile(configPath, 'utf-8');
      expect(onDisk).toContain('admin_password = "real-admin-password"');
      expect(onDisk).not.toContain('admin_password = "********"');
      // And the unrelated edit did take effect
      expect(onDisk).toContain('signup_mode = "open"');
    });

    it('accepts a real new value for a sensitive key (not the placeholder)', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const { POST } = await loadRoute();
      const newConfig = VALID_CONFIG.replace(
        'admin_password = "real-admin-password"',
        'admin_password = "new-password-xyz"',
      );
      const response = await POST(postRequest({ config_toml: newConfig, checksum: sha256(VALID_CONFIG) }));
      expect(response.status).toBe(200);
      const onDisk = await fs.readFile(configPath, 'utf-8');
      expect(onDisk).toContain('admin_password = "new-password-xyz"');
    });

    it('managed deployment: rejects an admin_password change with 400', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      process.env.ADMIN_PASSWORD_MANAGED = 'true';
      const { POST } = await loadRoute();
      const newConfig = VALID_CONFIG.replace(
        'admin_password = "real-admin-password"',
        'admin_password = "user-chosen-password"',
      );
      const response = await POST(postRequest({ config_toml: newConfig, checksum: sha256(VALID_CONFIG) }));
      const payload = await response.json();
      expect(response.status).toBe(400);
      expect(payload.error).toContain('managed by Umbrel');
      // File untouched
      const onDisk = await fs.readFile(configPath, 'utf-8');
      expect(onDisk).toContain('admin_password = "real-admin-password"');
    });

    it('managed deployment: redaction-roundtrip placeholder is NOT treated as a change', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      process.env.ADMIN_PASSWORD_MANAGED = 'true';
      const { GET, POST } = await loadRoute();
      const redactedView = (await (await GET(getRequest())).json()).config as string;
      const userEdit = redactedView.replace('token_required', 'open');
      const response = await POST(postRequest({ config_toml: userEdit, checksum: sha256(VALID_CONFIG) }));
      expect(response.status).toBe(200);
      const onDisk = await fs.readFile(configPath, 'utf-8');
      expect(onDisk).toContain('admin_password = "real-admin-password"');
      expect(onDisk).toContain('signup_mode = "open"');
    });

    it('unmanaged deployment: admin_password stays editable', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      delete process.env.ADMIN_PASSWORD_MANAGED;
      const { POST } = await loadRoute();
      const newConfig = VALID_CONFIG.replace(
        'admin_password = "real-admin-password"',
        'admin_password = "native-deploy-password"',
      );
      const response = await POST(postRequest({ config_toml: newConfig, checksum: sha256(VALID_CONFIG) }));
      expect(response.status).toBe(200);
      const onDisk = await fs.readFile(configPath, 'utf-8');
      expect(onDisk).toContain('admin_password = "native-deploy-password"');
    });

    it('atomic write: original file unchanged if rename fails mid-write', async () => {
      await fs.writeFile(configPath, VALID_CONFIG, 'utf-8');
      const { POST } = await loadRoute();
      const renameSpy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('ENOSPC'));
      const response = await POST(
        postRequest({
          config_toml: VALID_CONFIG.replace('token_required', 'open'),
          checksum: sha256(VALID_CONFIG),
        }),
      );
      expect(response.status).toBe(500);
      // Original file content preserved
      expect(await fs.readFile(configPath, 'utf-8')).toBe(VALID_CONFIG);
      renameSpy.mockRestore();
    });
  });
});
