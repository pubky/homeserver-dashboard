/**
 * Verifies a Pubky AuthToken: the proof Pubky Ring signs when its user
 * approves a `pubkyauth://` request.
 *
 * Verified here with Node's own Ed25519 instead of the Pubky SDK on purpose:
 * loading the SDK's Node build replaces the process-wide `fetch` with a
 * cookie-jar wrapper, which would make every proxied request in this server
 * share one cookie jar.
 *
 * Wire format (version 0, from pubky-common `AuthToken`, postcard encoded):
 *
 *   0   64  signature
 *   64  10  namespace, "PUBKY:AUTH"
 *   74   1  version, 0
 *   75   8  timestamp, microseconds since the epoch, big endian
 *   83  32  the signer's public key
 *   115  n  capabilities: a varint length, then that many bytes of UTF-8
 *
 * The signature covers everything from byte 65 on (not 64: the namespace's
 * first byte is outside it, as in pubky-common). A token says who signed and
 * which capabilities they agreed to, and nothing about whom it was signed
 * for, so a caller must also check the capabilities are ones only it asked for.
 */
import { createPublicKey, verify } from 'crypto';

const SIGNATURE_LENGTH = 64;
const NAMESPACE = Buffer.from('PUBKY:AUTH', 'ascii');
const VERSION_OFFSET = 74;
const TIMESTAMP_OFFSET = 75;
const PUBLIC_KEY_OFFSET = 83;
const CAPABILITIES_OFFSET = 115;
const SIGNED_FROM = 65;
/** The fixed part plus the one-byte length of an empty capability list. */
const MIN_TOKEN_LENGTH = CAPABILITIES_OFFSET + 1;
/** Far above any real token; keeps hostile input small. */
export const MAX_TOKEN_LENGTH = 4096;
/** pubky-common accepts a timestamp up to 3 minutes either side of now. */
const TIMESTAMP_WINDOW_MS = 180_000;
/** DER prefix that turns 32 raw bytes into an Ed25519 SubjectPublicKeyInfo. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export type RingToken = {
  /** The 32-byte Ed25519 key that signed the token. */
  publicKey: Buffer;
  /** The capability list exactly as signed, e.g. `/pub/app/:rw,/x/y:r`. */
  capabilities: string;
};

export type RingTokenError = 'malformed' | 'unsupported_version' | 'expired' | 'bad_signature';

export type RingTokenResult = { ok: true; token: RingToken } | { ok: false; error: RingTokenError };

const fail = (error: RingTokenError): RingTokenResult => ({ ok: false, error });

/** A canonical single-byte or multi-byte LEB128 length, or null. */
function readVarint(bytes: Buffer, offset: number): { value: number; next: number } | null {
  let value = 0;
  for (let i = 0; i < 3; i += 1) {
    const byte = bytes[offset + i];
    if (byte === undefined) return null;
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) {
      // Reject padded encodings such as 0x80 0x00, so one token has one byte form.
      if (i > 0 && byte === 0) return null;
      return { value, next: offset + i + 1 };
    }
  }
  return null;
}

/** The capability text, which must run exactly to the end of the token; null otherwise. */
function readCapabilities(bytes: Buffer): string | null {
  const length = readVarint(bytes, CAPABILITIES_OFFSET);
  if (!length || length.next + length.value !== bytes.length) return null;
  try {
    // ignoreBOM: a leading byte-order mark stays in the text, so it cannot be a
    // second spelling of the same capability.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(length.next));
  } catch {
    return null;
  }
}

function isSignedBy(bytes: Buffer, publicKey: Buffer): boolean {
  try {
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, publicKey]), format: 'der', type: 'spki' });
    return verify(null, bytes.subarray(SIGNED_FROM), key, bytes.subarray(0, SIGNATURE_LENGTH));
  } catch {
    // Not a valid curve point, so nothing can have been signed with it.
    return false;
  }
}

/**
 * Checks the token's shape, version, freshness and signature.
 * `nowMs` is the verifier's clock, a parameter so tests can pin it.
 */
export function verifyRingToken(input: Uint8Array, nowMs: number = Date.now()): RingTokenResult {
  if (input.length < MIN_TOKEN_LENGTH || input.length > MAX_TOKEN_LENGTH) return fail('malformed');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);

  if (!bytes.subarray(SIGNATURE_LENGTH, VERSION_OFFSET).equals(NAMESPACE)) return fail('malformed');
  if (bytes[VERSION_OFFSET] !== 0) return fail('unsupported_version');
  const capabilities = readCapabilities(bytes);
  if (capabilities === null) return fail('malformed');

  const timestampMs = Number(bytes.readBigUInt64BE(TIMESTAMP_OFFSET) / 1000n);
  if (Math.abs(timestampMs - nowMs) > TIMESTAMP_WINDOW_MS) return fail('expired');

  const publicKey = Buffer.from(bytes.subarray(PUBLIC_KEY_OFFSET, CAPABILITIES_OFFSET));
  if (!isSignedBy(bytes, publicKey)) return fail('bad_signature');

  return { ok: true, token: { publicKey, capabilities } };
}
