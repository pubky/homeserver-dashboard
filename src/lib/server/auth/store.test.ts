// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CHALLENGE_TTL_MS,
  SESSION_IDLE_MS,
  SESSION_MAX_MS,
  consumeChallenge,
  createChallenge,
  createSession,
  deleteSession,
  getSession,
  isLiveChallenge,
  resetAuthStore,
  touchSession,
} from './store';

const T0 = 1_800_000_000_000;
const ADMIN = Buffer.alloc(32, 7);

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** The last character of 43 carries 4 data bits and 2 spare ones; flip a spare one. */
const sameBytesOtherSpelling = (last: string) => BASE64URL[BASE64URL.indexOf(last) ^ 1];

describe('sign-in attempts', () => {
  beforeEach(resetAuthStore);

  it('gives every attempt its own nonce and verifier', () => {
    const a = createChallenge(T0);
    const b = createChallenge(T0);
    expect(a.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.nonce).not.toBe(b.nonce);
    expect(a.verifier).not.toBe(b.verifier);
  });

  it('accepts the right verifier, and uses the attempt up only when told to', () => {
    const { nonce, verifier } = createChallenge(T0);
    expect(isLiveChallenge(nonce, verifier, T0 + 1000)).toBe(true);
    expect(isLiveChallenge(nonce, verifier, T0 + 2000)).toBe(true);
    expect(consumeChallenge(nonce, verifier, T0 + 3000)).toBe(true);
    expect(isLiveChallenge(nonce, verifier, T0 + 4000)).toBe(false);
    expect(consumeChallenge(nonce, verifier, T0 + 4000)).toBe(false);
  });

  it.each([
    ['a guess', () => 'not-the-verifier'],
    ['an empty string', () => ''],
    ['the right expiry with a made-up MAC', (v: string) => `${v.split('.')[0]}.${'A'.repeat(43)}`],
    ['the right MAC with a later expiry', (v: string) => `${(T0 * 2).toString(36)}.${v.split('.')[1]}`],
    ['the verifier with one character changed', (v: string) => v.slice(0, -1) + (v.endsWith('A') ? 'B' : 'A')],
    ['the verifier with something appended', (v: string) => `${v}A`],
    ['a MAC that is not base64url', (v: string) => `${v.split('.')[0]}.${'!'.repeat(43)}`],
    // Other spellings of the very same verifier: one verifier, one string.
    ['a leading zero on the expiry', (v: string) => `0${v}`],
    ['spare bits set in the last character', (v: string) => v.slice(0, -1) + sameBytesOtherSpelling(v.slice(-1))],
  ])('refuses %s and leaves the attempt usable', (_case, forge) => {
    const { nonce, verifier } = createChallenge(T0);
    expect(isLiveChallenge(nonce, forge(verifier), T0)).toBe(false);
    expect(consumeChallenge(nonce, forge(verifier), T0)).toBe(false);
    expect(consumeChallenge(nonce, verifier, T0)).toBe(true);
  });

  it("refuses one attempt's verifier for another attempt", () => {
    const a = createChallenge(T0);
    const b = createChallenge(T0);
    expect(isLiveChallenge(a.nonce, b.verifier, T0)).toBe(false);
  });

  it('refuses a nonce this server never issued', () => {
    const { verifier } = createChallenge(T0);
    expect(isLiveChallenge('0'.repeat(32), verifier, T0)).toBe(false);
  });

  it('expires an attempt after its time limit', () => {
    const { nonce, verifier } = createChallenge(T0);
    expect(isLiveChallenge(nonce, verifier, T0 + CHALLENGE_TTL_MS)).toBe(true);
    expect(isLiveChallenge(nonce, verifier, T0 + CHALLENGE_TTL_MS + 1)).toBe(false);
    expect(consumeChallenge(nonce, verifier, T0 + CHALLENGE_TTL_MS + 1)).toBe(false);
  });

  it('cannot be pushed out by any number of other attempts', () => {
    const first = createChallenge(T0);
    for (let i = 0; i < 5000; i += 1) createChallenge(T0);
    expect(consumeChallenge(first.nonce, first.verifier, T0)).toBe(true);
  });

  it('remembers a used attempt for as long as it could otherwise be replayed', () => {
    const used = createChallenge(T0);
    expect(consumeChallenge(used.nonce, used.verifier, T0)).toBe(true);
    // Later sign-ins tidy the list of used attempts; this one must survive that.
    for (let i = 1; i <= 50; i += 1) {
      const other = createChallenge(T0 + i);
      expect(consumeChallenge(other.nonce, other.verifier, T0 + i)).toBe(true);
    }
    expect(isLiveChallenge(used.nonce, used.verifier, T0 + CHALLENGE_TTL_MS)).toBe(false);
  });
});

describe('sessions', () => {
  beforeEach(resetAuthStore);

  /** What a request does: counts as activity if the session is still live. */
  const use = (id: string, now: number) => {
    touchSession(id, now);
    return getSession(id, now);
  };

  it('finds a session by its id and nothing by any other id', () => {
    const id = createSession(ADMIN, T0);
    expect(id.length).toBeGreaterThanOrEqual(43);
    expect(getSession(id, T0)?.admin).toEqual(ADMIN);
    expect(getSession(`${id}x`, T0)).toBeNull();
    expect(getSession('', T0)).toBeNull();
    expect(createSession(ADMIN, T0)).not.toBe(id);
  });

  it('ends a session that has been idle too long', () => {
    const id = createSession(ADMIN, T0);
    expect(use(id, T0 + SESSION_IDLE_MS)).not.toBeNull();
    expect(use(id, T0 + 2 * SESSION_IDLE_MS + 1)).toBeNull();
    expect(use(id, T0)).toBeNull();
  });

  it('does not let a status check keep a session alive', () => {
    const id = createSession(ADMIN, T0);
    expect(getSession(id, T0 + SESSION_IDLE_MS)).not.toBeNull();
    expect(getSession(id, T0 + SESSION_IDLE_MS + 1)).toBeNull();
  });

  it('ends a session at the maximum lifetime however active it is', () => {
    const id = createSession(ADMIN, T0);
    for (let t = T0; t <= T0 + SESSION_MAX_MS; t += SESSION_IDLE_MS / 2) {
      expect(use(id, t)).not.toBeNull();
    }
    expect(use(id, T0 + SESSION_MAX_MS + 1)).toBeNull();
  });

  it('reports when the session will end', () => {
    const id = createSession(ADMIN, T0);
    expect(getSession(id, T0)?.expiresAt).toBe(T0 + SESSION_IDLE_MS);
    const late = T0 + SESSION_MAX_MS - 1000;
    for (let t = T0; t < late; t += SESSION_IDLE_MS / 2) use(id, t);
    expect(use(id, late)?.expiresAt).toBe(T0 + SESSION_MAX_MS);
  });

  it('forgets a deleted session', () => {
    const id = createSession(ADMIN, T0);
    deleteSession(id);
    expect(getSession(id, T0)).toBeNull();
  });

  it('keeps its own copy of the admin key', () => {
    const key = Buffer.alloc(32, 9);
    const id = createSession(key, T0);
    key.fill(0);
    expect(getSession(id, T0)?.admin).toEqual(Buffer.alloc(32, 9));
  });
});
