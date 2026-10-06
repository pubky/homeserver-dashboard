/**
 * In-memory state for the admin sign-in: the key that authenticates sign-in
 * attempts ("challenges"), the attempts already used, and signed-in sessions.
 * Lost on restart, which only means signing in again; nothing here is written
 * to disk.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

/** How long a started sign-in may take, QR scan included. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** A session ends after this long without a request... */
export const SESSION_IDLE_MS = 30 * 60 * 1000;
/** ...and at the latest this long after sign-in. */
export const SESSION_MAX_MS = 8 * 60 * 60 * 1000;

const MAX_SESSIONS = 100;

type Session = { admin: Buffer; createdAt: number; lastSeenAt: number };
type AuthStore = {
  /** Authenticates challenges, so issuing one stores nothing. New on every start. */
  challengeKey: Buffer;
  /** Nonces of attempts that have signed someone in, until they would have expired anyway. */
  usedChallenges: Map<string, number>;
  sessions: Map<string, Session>;
};

// On globalThis, not in module scope: Next may load this module more than
// once in one process (per route bundle), and every copy must see the same
// sessions.
const STORE_KEY = Symbol.for('homeserver-dashboard.auth-store');

function store(): AuthStore {
  const holder = globalThis as { [STORE_KEY]?: AuthStore };
  holder[STORE_KEY] ??= { challengeKey: randomBytes(32), usedChallenges: new Map(), sessions: new Map() };
  return holder[STORE_KEY];
}

function sessionExpired(session: Session, now: number): boolean {
  return now - session.createdAt > SESSION_MAX_MS || now - session.lastSeenAt > SESSION_IDLE_MS;
}

const VERIFIER = /^([0-9a-z]{1,12})\.([A-Za-z0-9_-]{43})$/;

function challengeMac(nonce: string, expiresAt: number): Buffer {
  return createHmac('sha256', store().challengeKey).update(`${nonce}.${expiresAt}`).digest();
}

/**
 * Starts a sign-in attempt.
 *
 * `nonce` is public: it goes into the capability Ring signs, so the signed
 * token names this one attempt. `verifier` is secret and stays in the browser
 * that started the attempt. A token alone is not enough to finish signing in,
 * which matters because the token travels through a relay and anyone who
 * sees the QR code can fetch it there.
 *
 * Nothing is stored per attempt: the verifier is the attempt's expiry time and
 * a MAC over nonce and expiry under a key only this process has. Anyone can
 * ask for attempts, so holding them in memory would let a flood of requests
 * push a real one out.
 */
export function createChallenge(now: number = Date.now()): { nonce: string; verifier: string } {
  const nonce = randomBytes(16).toString('hex');
  const expiresAt = now + CHALLENGE_TTL_MS;
  return { nonce, verifier: `${expiresAt.toString(36)}.${challengeMac(nonce, expiresAt).toString('base64url')}` };
}

/**
 * When the attempt `nonce` ends, if `verifier` is the one this process issued
 * for it; null for anything else.
 */
function issuedChallengeExpiry(nonce: string, verifier: string): number | null {
  const parts = VERIFIER.exec(verifier);
  if (!parts) return null;
  const expiresAt = parseInt(parts[1], 36);
  const mac = Buffer.from(parts[2], 'base64url');
  const expected = challengeMac(nonce, expiresAt);
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) return null;
  // One spelling per verifier: no leading zeros, no spare bits in the last character.
  if (parts[1] !== expiresAt.toString(36) || parts[2] !== mac.toString('base64url')) return null;
  return expiresAt;
}

/**
 * True when `nonce` is an attempt this process issued to the holder of
 * `verifier`, still within its time limit and not yet used to sign in.
 */
export function isLiveChallenge(nonce: string, verifier: string, now: number = Date.now()): boolean {
  const expiresAt = issuedChallengeExpiry(nonce, verifier);
  return expiresAt !== null && now <= expiresAt && !store().usedChallenges.has(nonce);
}

/**
 * Uses a live attempt up, so one signed token signs in once. Returns false,
 * changing nothing, when the attempt is not live. Only a completed sign-in
 * calls this, so only admins can add to the list of used attempts.
 */
export function consumeChallenge(nonce: string, verifier: string, now: number = Date.now()): boolean {
  const expiresAt = issuedChallengeExpiry(nonce, verifier);
  const { usedChallenges } = store();
  if (expiresAt === null || now > expiresAt || usedChallenges.has(nonce)) return false;
  for (const [used, usedExpiresAt] of usedChallenges) {
    if (now > usedExpiresAt) usedChallenges.delete(used);
  }
  usedChallenges.set(nonce, expiresAt);
  return true;
}

/** Maps keep insertion order, so the first key is the oldest entry. */
function dropOldest<V>(map: Map<string, V>, max: number) {
  while (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

/** Opens a session for an admin key and returns its secret id. */
export function createSession(admin: Buffer, now: number = Date.now()): string {
  const { sessions } = store();
  for (const [id, session] of sessions) {
    if (sessionExpired(session, now)) sessions.delete(id);
  }
  dropOldest(sessions, MAX_SESSIONS);

  const id = randomBytes(32).toString('base64url');
  sessions.set(id, { admin: Buffer.from(admin), createdAt: now, lastSeenAt: now });
  return id;
}

export type SessionView = { id: string; admin: Buffer; expiresAt: number };

function liveSession(id: string, now: number): Session | null {
  const { sessions } = store();
  const session = sessions.get(id);
  if (!session) return null;
  if (sessionExpired(session, now)) {
    sessions.delete(id);
    return null;
  }
  return session;
}

/** The live session with this id, or null. Looking does not count as activity. */
export function getSession(id: string, now: number = Date.now()): SessionView | null {
  const session = liveSession(id, now);
  if (!session) return null;
  const expiresAt = Math.min(session.createdAt + SESSION_MAX_MS, session.lastSeenAt + SESSION_IDLE_MS);
  return { id, admin: session.admin, expiresAt };
}

/** Records activity on a live session, restarting its idle timer. */
export function touchSession(id: string, now: number = Date.now()): void {
  const session = liveSession(id, now);
  if (session) session.lastSeenAt = now;
}

export function deleteSession(id: string): void {
  store().sessions.delete(id);
}

/** Test helper: forget every attempt and session. */
export function resetAuthStore(): void {
  const { usedChallenges, sessions } = store();
  usedChallenges.clear();
  sessions.clear();
}
