/**
 * A stand-in for Pubky Ring in tests: makes key pairs and signs AuthTokens.
 * The byte layout it writes is checked against tokens from the real
 * pubky-common in ring-token.test.ts, so tests built on it are not just
 * agreeing with themselves.
 */
import { type KeyObject, generateKeyPairSync, sign } from 'crypto';
import { formatPubky } from '../pubky-key';

export type TestIdentity = { privateKey: KeyObject; publicKey: Buffer; pubky: string };

export function newIdentity(): TestIdentity {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
  return { privateKey, publicKey: raw, pubky: formatPubky(raw) };
}

/** A version 0 AuthToken over `capabilities`, signed by `identity` at `signedAtMs`. */
export function signToken(identity: TestIdentity, capabilities: string, signedAtMs: number = Date.now()): Uint8Array {
  const caps = Buffer.from(capabilities, 'utf-8');
  if (caps.length > 127) throw new Error('test helper only writes one-byte lengths');
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(signedAtMs) * 1000n);
  const unsigned = Buffer.concat([
    Buffer.from('PUBKY:AUTH', 'ascii'),
    Buffer.from([0]),
    timestamp,
    identity.publicKey,
    Buffer.from([caps.length]),
    caps,
  ]);
  // The signature starts one byte into the namespace, as in pubky-common.
  const signature = sign(null, unsigned.subarray(1), identity.privateKey);
  return new Uint8Array(Buffer.concat([signature, unsigned]));
}
