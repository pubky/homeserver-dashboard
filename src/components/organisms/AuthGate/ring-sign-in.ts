/**
 * The browser's half of the admin sign-in with Pubky Ring.
 *
 * The server issues a one-off capability and a verifier. Ring signs the
 * capability, and the signed token comes back through the relay. The token is
 * then sent to the server together with the verifier. The verifier stays in
 * this module's closures and goes nowhere but back to the server, so the token
 * alone (which anyone who sees the QR code can fetch from the relay) cannot
 * be used to sign in elsewhere.
 */
import type { Capabilities } from '@synonymdev/pubky';

type Challenge = { capability: string; verifier: string; relay: string | null; expiresInSecs: number };

export type RingSignIn = {
  /** The `pubkyauth://` link to show as a QR code and to open on this device. */
  authUrl: string;
  /** Resolves with the token once the request is approved in Ring; rejects when the attempt expires. */
  awaitApproval: () => Promise<Uint8Array>;
  /** Sends the approved token to the server, which sets the session cookie. Rejects with the server's reason. */
  complete: (token: Uint8Array) => Promise<void>;
};

async function errorOf(response: Response): Promise<Error> {
  const fallback = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { error?: string };
    return new Error(body.error || fallback);
  } catch {
    return new Error(fallback);
  }
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** `promise`, or a rejection with `message` if it has not settled after `ms`. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  // Cleared either way, so no timer outlives the attempt.
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function requestChallenge(): Promise<Challenge> {
  const response = await fetch('/api/auth/challenge', { method: 'POST', cache: 'no-store' });
  if (!response.ok) throw await errorOf(response);
  return (await response.json()) as Challenge;
}

async function submitSignIn(token: Uint8Array, verifier: string): Promise<void> {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: toBase64(token), verifier }),
  });
  if (!response.ok) throw await errorOf(response);
}

/** Starts a sign-in attempt and hands back the steps that finish it. */
export async function startRingSignIn(): Promise<RingSignIn> {
  const challenge = await requestChallenge();
  // Loaded here, in the browser, on demand: the SDK is large, and its Node
  // build must never run inside the dashboard's server.
  const sdk = await import('@synonymdev/pubky');
  const flow = new sdk.Pubky().startCookieAuthFlow(
    challenge.capability as Capabilities,
    sdk.AuthFlowKind.signin(),
    challenge.relay,
  );
  const approval = flow.awaitToken().then((token) => token.toBytes());
  return {
    authUrl: flow.authorizationUrl,
    awaitApproval: () => withTimeout(approval, challenge.expiresInSecs * 1000, 'This sign-in expired. Start again.'),
    complete: (token) => submitSignIn(token, challenge.verifier),
  };
}
