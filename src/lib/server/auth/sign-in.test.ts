// @vitest-environment node
import { beforeEach, describe, expect, it } from 'vitest';
import { newIdentity, signToken } from './__fixtures__/ring';
import { signIn, signInCapability } from './sign-in';
import { CHALLENGE_TTL_MS, createChallenge, getSession, resetAuthStore } from './store';

const NOW = 1_800_000_000_000;

describe('signIn', () => {
  const admin = newIdentity();
  const otherAdmin = newIdentity();
  const stranger = newIdentity();
  const config = { mode: 'on' as const, admins: [admin.publicKey, otherAdmin.publicKey], relay: null };

  beforeEach(resetAuthStore);

  /** An attempt started in "this browser", and the token Ring would sign for it. */
  function attempt(signer = admin) {
    const { nonce, verifier } = createChallenge(NOW);
    return { nonce, verifier, token: signToken(signer, signInCapability(nonce), NOW) };
  }

  it('opens a session for an admin who signed this attempt', () => {
    const { token, verifier } = attempt();
    const result = signIn(config, token, verifier, NOW);
    if (!result.ok) throw new Error(`expected success, got ${result.reason}`);
    expect(result.admin).toEqual(admin.publicKey);
    expect(getSession(result.sessionId, NOW)?.admin).toEqual(admin.publicKey);
  });

  it('signs in once per signed token: a replay is refused', () => {
    const { token, verifier } = attempt();
    expect(signIn(config, token, verifier, NOW).ok).toBe(true);
    expect(signIn(config, token, verifier, NOW)).toMatchObject({ ok: false, reason: 'wrong_attempt' });
  });

  it('refuses a key that is not an admin, and does not use up the attempt', () => {
    const { nonce, verifier } = createChallenge(NOW);
    const strangerToken = signToken(stranger, signInCapability(nonce), NOW);
    expect(signIn(config, strangerToken, verifier, NOW)).toEqual({
      ok: false,
      reason: 'not_admin',
      signer: stranger.publicKey,
    });
    const adminToken = signToken(admin, signInCapability(nonce), NOW);
    expect(signIn(config, adminToken, verifier, NOW).ok).toBe(true);
  });

  it('tells someone who only holds a token nothing about its signer', () => {
    // Tokens copied off the relay, presented without the verifier of their attempt.
    const fromAdmin = attempt(admin);
    const fromStranger = attempt(stranger);
    const answers = [fromAdmin, fromStranger].map(({ token }) => signIn(config, token, 'guess', NOW));
    expect(answers[0]).toEqual({ ok: false, reason: 'wrong_attempt' });
    expect(answers[1]).toEqual(answers[0]);
  });

  it('refuses a token without the verifier of its attempt', () => {
    const { token } = attempt();
    expect(signIn(config, token, 'guess', NOW)).toMatchObject({ ok: false, reason: 'wrong_attempt' });
    expect(signIn(config, token, '', NOW)).toMatchObject({ ok: false, reason: 'wrong_attempt' });
  });

  it("refuses a token presented with another attempt's verifier", () => {
    const mine = attempt();
    const theirs = attempt(otherAdmin);
    expect(signIn(config, theirs.token, mine.verifier, NOW)).toMatchObject({ ok: false, reason: 'wrong_attempt' });
    // The interference did not spoil either attempt.
    expect(signIn(config, mine.token, mine.verifier, NOW).ok).toBe(true);
    expect(signIn(config, theirs.token, theirs.verifier, NOW).ok).toBe(true);
  });

  it('refuses an admin-signed token for an attempt this server never issued', () => {
    const { verifier } = createChallenge(NOW);
    const token = signToken(admin, signInCapability('f'.repeat(32)), NOW);
    expect(signIn(config, token, verifier, NOW)).toMatchObject({ ok: false, reason: 'wrong_attempt' });
  });

  it.each([
    ['signed for another application', () => '/pub/some-app/:rw'],
    ['with no capabilities', () => ''],
    ['with our capability plus another', (nonce: string) => `/pub/some-app/:rw,${signInCapability(nonce)}`],
    ['with our capability listed twice', (nonce: string) => `${signInCapability(nonce)},${signInCapability(nonce)}`],
    ['with write access on our path', (nonce: string) => `/homeserver-dashboard/signin/${nonce}:rw`],
    ['for a longer path under ours', (nonce: string) => `/homeserver-dashboard/signin/${nonce}/x:r`],
    ['with an uppercase nonce', (nonce: string) => `/homeserver-dashboard/signin/${nonce.toUpperCase()}:r`],
    ['with a trailing newline', (nonce: string) => `${signInCapability(nonce)}\n`],
    // A decoder that drops a leading byte-order mark would read this as our capability.
    ['with a byte-order mark in front', (nonce: string) => `\uFEFF${signInCapability(nonce)}`],
  ])('refuses an admin-signed token %s', (_case, capabilities) => {
    const { nonce, verifier } = createChallenge(NOW);
    const token = signToken(admin, capabilities(nonce), NOW);
    expect(signIn(config, token, verifier, NOW)).toMatchObject({ ok: false, reason: 'wrong_attempt' });
  });

  it('refuses an attempt that took too long, even with a freshly signed token', () => {
    const { nonce, verifier } = createChallenge(NOW);
    const later = NOW + CHALLENGE_TTL_MS + 1;
    const token = signToken(admin, signInCapability(nonce), later);
    expect(signIn(config, token, verifier, later)).toMatchObject({ ok: false, reason: 'wrong_attempt' });
  });

  it('refuses a stale token for a live attempt', () => {
    const { nonce, verifier } = createChallenge(NOW);
    const token = signToken(admin, signInCapability(nonce), NOW - 181_000);
    expect(signIn(config, token, verifier, NOW)).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses a token whose signature does not verify, without naming a signer', () => {
    const { token, verifier } = attempt();
    token[10] ^= 0xff;
    expect(signIn(config, token, verifier, NOW)).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses a token that claims an admin key but was signed by someone else', () => {
    const { nonce, verifier } = createChallenge(NOW);
    const forged = signToken(stranger, signInCapability(nonce), NOW);
    forged.set(admin.publicKey, 83);
    expect(signIn(config, forged, verifier, NOW)).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('refuses garbage', () => {
    const { verifier } = createChallenge(NOW);
    expect(signIn(config, new Uint8Array(0), verifier, NOW)).toEqual({ ok: false, reason: 'invalid_token' });
    expect(signIn(config, new Uint8Array(200), verifier, NOW)).toEqual({ ok: false, reason: 'invalid_token' });
  });

  it('lets no one in when the admin list is empty', () => {
    const { token, verifier } = attempt();
    expect(signIn({ mode: 'on', admins: [], relay: null }, token, verifier, NOW)).toMatchObject({
      ok: false,
      reason: 'not_admin',
    });
  });
});
