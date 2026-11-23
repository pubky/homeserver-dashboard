// @vitest-environment node
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { homeserverAdmin } from './homeserver-admin';

const CONFIG = `
[general]
signup_mode = "token_required"

[admin]
enabled = true
listen_socket = "127.0.0.1:6288"
admin_password = "from-the-config"
`;

describe('homeserverAdmin', () => {
  let dir: string;
  let configPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'homeserver-admin-'));
    configPath = path.join(dir, 'config.toml');
    vi.stubEnv('HOMESERVER_CONFIG_PATH', configPath);
    vi.stubEnv('ADMIN_BASE_URL', '');
    vi.stubEnv('ADMIN_TOKEN', '');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('uses the variables when both are set, without reading the config', async () => {
    await fs.writeFile(configPath, CONFIG);
    vi.stubEnv('ADMIN_BASE_URL', 'http://homeserver:6288');
    vi.stubEnv('ADMIN_TOKEN', 'from-the-env');
    const readFile = vi.spyOn(fs, 'readFile');
    expect(await homeserverAdmin()).toEqual({ baseUrl: 'http://homeserver:6288', token: 'from-the-env' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('reads both from the config when neither variable is set', async () => {
    await fs.writeFile(configPath, CONFIG);
    expect(await homeserverAdmin()).toEqual({ baseUrl: 'http://127.0.0.1:6288', token: 'from-the-config' });
  });

  it('fills in only the one that is not set: a variable always wins', async () => {
    await fs.writeFile(configPath, CONFIG);
    vi.stubEnv('ADMIN_TOKEN', 'from-the-env');
    expect(await homeserverAdmin()).toEqual({ baseUrl: 'http://127.0.0.1:6288', token: 'from-the-env' });

    vi.stubEnv('ADMIN_TOKEN', '');
    vi.stubEnv('ADMIN_BASE_URL', 'http://homeserver:6288');
    expect(await homeserverAdmin()).toEqual({ baseUrl: 'http://homeserver:6288', token: 'from-the-config' });
  });

  it('picks up a password changed in the config without a restart', async () => {
    await fs.writeFile(configPath, CONFIG);
    expect((await homeserverAdmin()).token).toBe('from-the-config');
    await fs.writeFile(configPath, CONFIG.replace('from-the-config', 'changed'));
    expect((await homeserverAdmin()).token).toBe('changed');
  });

  it.each([
    ['0.0.0.0:6288', 'http://127.0.0.1:6288'],
    ['[::]:6288', 'http://[::1]:6288'],
    ['[::1]:7000', 'http://[::1]:7000'],
    ['10.0.0.5:6288', 'http://10.0.0.5:6288'],
    ['127.0.0.1:80', 'http://127.0.0.1'],
  ])('calls %s at %s', async (listenSocket, expected) => {
    await fs.writeFile(configPath, CONFIG.replace('127.0.0.1:6288', listenSocket));
    expect((await homeserverAdmin()).baseUrl).toBe(expected);
  });

  it('leaves out what neither the variables nor the config give', async () => {
    // No file at all.
    expect(await homeserverAdmin()).toEqual({ baseUrl: undefined, token: undefined });

    await fs.writeFile(configPath, 'not = [toml');
    expect(await homeserverAdmin()).toEqual({ baseUrl: undefined, token: undefined });

    await fs.writeFile(configPath, '[admin]\nlisten_socket = "no port here"\nadmin_password = ""\n');
    expect(await homeserverAdmin()).toEqual({ baseUrl: undefined, token: undefined });

    await fs.writeFile(configPath, '[admin]\nlisten_socket = "127.0.0.1"\nadmin_password = 12345\n');
    expect(await homeserverAdmin()).toEqual({ baseUrl: undefined, token: undefined });
  });

  it('gives nothing for a config it is not allowed to read', async () => {
    await fs.writeFile(configPath, CONFIG);
    vi.spyOn(fs, 'readFile').mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    expect(await homeserverAdmin()).toEqual({ baseUrl: undefined, token: undefined });
  });

  it('says once why the config gave nothing, naming the path and the failure but nothing from the file', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await homeserverAdmin();
    await homeserverAdmin();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatchObject({
      level: 'warn',
      meta: { path: configPath, problem: 'cannot be read (ENOENT)' },
    });

    await fs.writeFile(configPath, 'admin_password = "the-secret\nbroken');
    await homeserverAdmin();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toMatchObject({ meta: { path: configPath, problem: 'is not valid TOML' } });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('the-secret');

    // Readable again, then broken again: the same failure is worth saying a second time.
    await fs.writeFile(configPath, CONFIG);
    await homeserverAdmin();
    await fs.rm(configPath);
    await homeserverAdmin();
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("falls back on the homeserver's default password for a config that sets none, and warns once", async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // A fresh config.toml: every setting commented out.
    await fs.writeFile(configPath, '# [admin]\n# listen_socket = "127.0.0.1:6288"\n# admin_password = "admin"\n');

    expect(await homeserverAdmin()).toEqual({ baseUrl: 'http://127.0.0.1:6288', token: 'admin' });
    await homeserverAdmin();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0].meta.problem).toContain('sets no [admin] admin_password');

    // With a password of its own there is nothing to warn about.
    warn.mockClear();
    await fs.writeFile(configPath, '[admin]\nadmin_password = "chosen"\n');
    expect(await homeserverAdmin()).toEqual({ baseUrl: 'http://127.0.0.1:6288', token: 'chosen' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not use or mention the default when ADMIN_TOKEN gives the password', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('ADMIN_TOKEN', 'from-the-env');
    await fs.writeFile(configPath, '# every setting commented out\n');
    expect((await homeserverAdmin()).token).toBe('from-the-env');
    expect(warn).not.toHaveBeenCalled();
  });

  it('reads an `admin` key that is not a table as a config without admin settings', async () => {
    await fs.writeFile(configPath, 'admin = "yes"\n');
    expect(await homeserverAdmin()).toEqual({ baseUrl: 'http://127.0.0.1:6288', token: 'admin' });
  });

  it('is the only place that reads ADMIN_BASE_URL and ADMIN_TOKEN from the environment', async () => {
    const src = path.resolve('src');
    const files = (await fs.readdir(src, { recursive: true, encoding: 'utf8' })).filter(
      (file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file) && !file.endsWith('homeserver-admin.ts'),
    );
    const readers: string[] = [];
    for (const file of files) {
      const source = await fs.readFile(path.join(src, file), 'utf8');
      const direct = /process\.env\.(ADMIN_BASE_URL|ADMIN_TOKEN)\b|process\.env\[['"](ADMIN_BASE_URL|ADMIN_TOKEN)/;
      const destructured = /\{[^}]*\b(ADMIN_BASE_URL|ADMIN_TOKEN)\b[^}]*\}\s*=\s*process\.env/;
      if (direct.test(source) || destructured.test(source)) {
        readers.push(file);
      }
    }
    // The scan found the source at all: an empty list would pass for the wrong reason.
    expect(files.length).toBeGreaterThan(50);
    expect(readers).toEqual([]);
  });
});
