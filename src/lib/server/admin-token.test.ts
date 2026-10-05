// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { getAdminToken } from './admin-token';

describe('getAdminToken', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;
  let configPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'admin-token-test-'));
    configPath = path.join(tmpDir, 'config.toml');
    process.env.HOMESERVER_CONFIG_PATH = configPath;
    delete process.env.ADMIN_TOKEN;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const writeConfig = (toml: string) => fs.writeFile(configPath, toml);

  it('reads admin_password from the homeserver config when ADMIN_TOKEN is unset', async () => {
    await writeConfig('[general]\nsignup_mode = "open"\n\n[admin]\nenabled = true\nadmin_password = "from-config"\n');
    expect(await getAdminToken()).toBe('from-config');
  });

  it('prefers ADMIN_TOKEN over the config file', async () => {
    await writeConfig('[admin]\nadmin_password = "from-config"\n');
    process.env.ADMIN_TOKEN = 'from-env';
    expect(await getAdminToken()).toBe('from-env');
  });

  it('picks up a changed password without a restart', async () => {
    await writeConfig('[admin]\nadmin_password = "first"\n');
    expect(await getAdminToken()).toBe('first');
    await writeConfig('[admin]\nadmin_password = "second"\n');
    expect(await getAdminToken()).toBe('second');
  });

  it.each([
    ['there is no config file', null],
    ['the file is not valid TOML', '[admin\nadmin_password = '],
    ['there is no [admin] table', '[general]\nsignup_mode = "open"\n'],
    ['admin_password is missing', '[admin]\nenabled = true\n'],
    ['admin_password is empty', '[admin]\nadmin_password = ""\n'],
    ['admin_password is not a string', '[admin]\nadmin_password = 12345\n'],
    ['admin is not a table', 'admin = "nope"\n'],
  ])('is undefined when %s', async (_case, toml) => {
    if (toml !== null) await writeConfig(toml);
    expect(await getAdminToken()).toBeUndefined();
  });
});
