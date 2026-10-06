/**
 * Turns a token signed by Pubky Ring into an admin session.
 *
 * A signed token proves "the holder of key K agreed to capabilities C around
 * time T". It does not say which application asked. So signing in takes all of:
 *
 *   1. a valid, fresh signature                       (verifyRingToken)
 *   2. over exactly the one capability this server issued for a sign-in
 *      attempt, so a token signed for any other app or purpose is useless here
 *   3. presented together with that attempt's verifier, which only the
 *      browser that started the attempt has, so a token copied off the relay
 *      (anyone who sees the QR code can fetch it) is useless on its own
 *   4. by a key listed in ADMIN_PUBKEYS
 *   5. once: a successful sign-in uses the attempt up
 *
 * The order matters for what a refusal gives away. Whether the signer is an
 * admin is only revealed (step 4) to the browser that started the attempt;
 * someone holding just a token learns nothing about its signer.
 *
 * What this cannot stop is an admin approving, in Ring, a sign-in that
 * someone else started: Ring does not show who is asking, so whoever showed
 * the QR code (a look-alike page, or any app's "sign in with Ring" that asks
 * for this capability) gets the session. Ring shows the capability below on
 * its consent screen for that reason.
 */
import { type ActiveAuthConfig, isAdminKey } from './config';
import { verifyRingToken } from './ring-token';
import { createSession, isLiveChallenge, consumeChallenge } from './store';

const CAPABILITY = /^\/homeserver-dashboard\/signin\/([0-9a-f]{32}):r$/;

/**
 * The capability Ring is asked to sign for one attempt. It is a path no
 * homeserver stores anything under, read-only: the token is also a valid
 * credential at the admin's own homeserver, so it must grant nothing there.
 */
export function signInCapability(nonce: string): string {
  return `/homeserver-dashboard/signin/${nonce}:r`;
}

export type SignInResult =
  | { ok: true; sessionId: string; admin: Buffer }
  | { ok: false; reason: 'invalid_token' | 'wrong_attempt' }
  /** The signer is only named here: to the browser that started the attempt. */
  | { ok: false; reason: 'not_admin'; signer: Buffer };

export function signIn(
  config: ActiveAuthConfig,
  tokenBytes: Uint8Array,
  verifier: string,
  now: number = Date.now(),
): SignInResult {
  const verified = verifyRingToken(tokenBytes, now);
  if (!verified.ok) return { ok: false, reason: 'invalid_token' };
  const { publicKey, capabilities } = verified.token;

  // The whole capability list must be our one capability: nothing else was asked for.
  const nonce = CAPABILITY.exec(capabilities)?.[1];
  if (!nonce || !isLiveChallenge(nonce, verifier, now)) return { ok: false, reason: 'wrong_attempt' };

  if (!isAdminKey(config, publicKey)) return { ok: false, reason: 'not_admin', signer: publicKey };

  // Everything is synchronous from the check above to here, so two requests
  // with the same token cannot both get past it.
  if (!consumeChallenge(nonce, verifier, now)) return { ok: false, reason: 'wrong_attempt' };

  return { ok: true, sessionId: createSession(publicKey, now), admin: publicKey };
}
