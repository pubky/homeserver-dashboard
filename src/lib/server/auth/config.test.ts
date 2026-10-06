// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAuthConfig, isAdminKey } from './config';
import { newIdentity } from './__fixtures__/ring';

describe('getAuthConfig', () => {
  const originalEnv = { ...process.env };
  const alice = newIdentity();
  const bob = newIdentity();

  beforeEach(() => {
    delete process.env.ADMIN_PUBKEYS;
    delete process.env.AUTH_RELAY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('is off only when ADMIN_PUBKEYS is not set at all', () => {
    expect(getAuthConfig()).toEqual({ mode: 'off' });
  });

  it.each([
    ['empty', ''],
    ['only whitespace', '  \n '],
    ['only separators', ' , ,'],
  ])('refuses a set-but-%s value instead of turning sign-in off', (_case, value) => {
    process.env.ADMIN_PUBKEYS = value;
    expect(getAuthConfig().mode).toBe('invalid');
  });

  it('lists the admins from a comma, space or newline separated value', () => {
    process.env.ADMIN_PUBKEYS = `${alice.pubky}, pubky${bob.pubky}\n`;
    expect(getAuthConfig()).toEqual({ mode: 'on', admins: [alice.publicKey, bob.publicKey], relay: null });
  });

  it('lists a repeated key once', () => {
    process.env.ADMIN_PUBKEYS = `${alice.pubky} pubky${alice.pubky}`;
    expect(getAuthConfig()).toMatchObject({ mode: 'on', admins: [alice.publicKey] });
  });

  it('refuses everything when any entry is not a pubky, naming which one', () => {
    process.env.ADMIN_PUBKEYS = `${alice.pubky},${bob.pubky.slice(1)}`;
    expect(getAuthConfig()).toEqual({ mode: 'invalid', reason: 'ADMIN_PUBKEYS entry 2 is not a pubky' });
  });

  it('passes on a relay URL and refuses one that is not http(s)', () => {
    process.env.ADMIN_PUBKEYS = alice.pubky;
    process.env.AUTH_RELAY = 'https://relay.example/link/';
    expect(getAuthConfig()).toMatchObject({ mode: 'on', relay: 'https://relay.example/link/' });
    process.env.AUTH_RELAY = 'relay.example';
    expect(getAuthConfig().mode).toBe('invalid');
    process.env.AUTH_RELAY = 'javascript:alert(1)';
    expect(getAuthConfig().mode).toBe('invalid');
  });

  it('matches admin keys by their bytes', () => {
    process.env.ADMIN_PUBKEYS = alice.pubky;
    const config = getAuthConfig();
    if (config.mode !== 'on') throw new Error('expected sign-in to be on');
    expect(isAdminKey(config, Buffer.from(alice.publicKey))).toBe(true);
    expect(isAdminKey(config, bob.publicKey)).toBe(false);
  });
});
