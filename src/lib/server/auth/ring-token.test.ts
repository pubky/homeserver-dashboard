// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { formatPubky, parsePubky } from './pubky-key';
import { MAX_TOKEN_LENGTH, verifyRingToken } from './ring-token';

// Real tokens, signed by pubky-common 0.14 (`AuthToken::sign`) with the secret
// key [7; 32]. They are the ground truth for the byte layout: this file never
// builds a token itself, so it cannot simply agree with its own assumptions.
const SIGNER_HEX = 'ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c';
const SIGNER_Z32 = '7jfgaa9nutjyixzikb7tgmsf9gkwq7iqz498zr1nd5ig1fng4esy';
const SCOPE = '/homeserver-dashboard/signin/0123456789abcdef0123456789abcdef:r';

const ONE_CAPABILITY = {
  hex: 'a2ffb9934fbbb6ec56c9ce5dc7a94438d2fec387f6321a7e81c806e156216136f20803422606ebfecafd966d19d882b92cee8ca5dc2b68a79aa47d696128e50d5055424b593a415554480000065d1942ebf5cfea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c3f2f686f6d657365727665722d64617368626f6172642f7369676e696e2f30313233343536373839616263646566303132333435363738396162636465663a72',
  signedAtMs: 1791212938589,
};
const TWO_CAPABILITIES = {
  hex: '1586f6125eaf46f17cc6b105a97ac54f121fafce25cb8abcc9a2efe65f9fa3b29f31420fcb4a8db4ce3281e37a24bcb44b8b98d498e338689e30d5850c484e045055424b593a415554480000065d1942ec0affea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c4c2f7075622f6170702f3a72772c2f686f6d657365727665722d64617368626f6172642f7369676e696e2f30313233343536373839616263646566303132333435363738396162636465663a72',
  signedAtMs: 1791212938595,
};
const NO_CAPABILITIES = {
  hex: '6dd2dc2d4decf129c87652cb38f2ae84e48bd674851bbc91817bae65f7f01110f180c7f9cc2759e6bfe665a937c935d51d630daa431e050de9675f9e807aed0b5055424b593a415554480000065d1942ec20dfea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c00',
  signedAtMs: 1791212938600,
};

const bytesOf = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'));

/** The token with one byte changed. */
function flipped(hex: string, offset: number): Uint8Array {
  const bytes = bytesOf(hex);
  bytes[offset] ^= 0x01;
  return bytes;
}

describe('verifyRingToken', () => {
  it('accepts a real token and reports its signer and capabilities', () => {
    const result = verifyRingToken(bytesOf(ONE_CAPABILITY.hex), ONE_CAPABILITY.signedAtMs);
    expect(result).toEqual({ ok: true, token: { publicKey: Buffer.from(SIGNER_HEX, 'hex'), capabilities: SCOPE } });
  });

  it('reports every capability of a multi-capability token, in signed order', () => {
    const result = verifyRingToken(bytesOf(TWO_CAPABILITIES.hex), TWO_CAPABILITIES.signedAtMs);
    expect(result.ok && result.token.capabilities).toBe(`/pub/app/:rw,${SCOPE}`);
  });

  it('accepts a real token with no capabilities', () => {
    const result = verifyRingToken(bytesOf(NO_CAPABILITIES.hex), NO_CAPABILITIES.signedAtMs);
    expect(result.ok && result.token.capabilities).toBe('');
  });

  it('reads a token out of a larger buffer without looking past it', () => {
    const token = Buffer.from(ONE_CAPABILITY.hex, 'hex');
    const padded = Buffer.concat([Buffer.alloc(7, 0xaa), token, Buffer.alloc(9, 0xbb)]);
    const view = new Uint8Array(padded.buffer, padded.byteOffset + 7, token.length);
    expect(verifyRingToken(view, ONE_CAPABILITY.signedAtMs).ok).toBe(true);
  });

  describe('freshness', () => {
    const token = bytesOf(ONE_CAPABILITY.hex);
    const at = (offsetMs: number) => verifyRingToken(token, ONE_CAPABILITY.signedAtMs + offsetMs);

    it('accepts a token up to 3 minutes old or 3 minutes ahead', () => {
      expect(at(180_000).ok).toBe(true);
      expect(at(-180_000).ok).toBe(true);
    });

    it('rejects a token older than 3 minutes', () => {
      expect(at(180_001)).toEqual({ ok: false, error: 'expired' });
    });

    it('rejects a token dated more than 3 minutes in the future', () => {
      expect(at(-180_001)).toEqual({ ok: false, error: 'expired' });
    });
  });

  describe('tampering', () => {
    const now = ONE_CAPABILITY.signedAtMs;

    it.each([
      ['the signature', 0],
      ['the last signature byte', 63],
      ['the public key', 83],
      ['the capability length', 115],
      ['the first capability byte', 116],
      ['the last capability byte', ONE_CAPABILITY.hex.length / 2 - 1],
    ])('rejects a token with a changed byte in %s', (_part, offset) => {
      expect(verifyRingToken(flipped(ONE_CAPABILITY.hex, offset), now).ok).toBe(false);
    });

    it('rejects a changed timestamp even when it is still inside the window', () => {
      // Lowest timestamp byte: moves the time by one microsecond.
      expect(verifyRingToken(flipped(ONE_CAPABILITY.hex, 82), now)).toEqual({ ok: false, error: 'bad_signature' });
    });

    it('rejects a different namespace, including in the one byte the signature does not cover', () => {
      expect(verifyRingToken(flipped(ONE_CAPABILITY.hex, 64), now)).toEqual({ ok: false, error: 'malformed' });
      expect(verifyRingToken(flipped(ONE_CAPABILITY.hex, 70), now)).toEqual({ ok: false, error: 'malformed' });
    });

    it('rejects an unknown version', () => {
      expect(verifyRingToken(flipped(ONE_CAPABILITY.hex, 74), now)).toEqual({
        ok: false,
        error: 'unsupported_version',
      });
    });

    it('rejects a token signed by one key and relabelled with another', () => {
      const bytes = bytesOf(ONE_CAPABILITY.hex);
      bytes.set(Buffer.alloc(32, 0x42), 83);
      expect(verifyRingToken(bytes, now).ok).toBe(false);
    });

    it('rejects a capability list swapped in from another token by the same signer', () => {
      const head = Buffer.from(ONE_CAPABILITY.hex, 'hex').subarray(0, 115);
      const tail = Buffer.from(NO_CAPABILITIES.hex, 'hex').subarray(115);
      expect(verifyRingToken(new Uint8Array(Buffer.concat([head, tail])), now)).toEqual({
        ok: false,
        error: 'bad_signature',
      });
    });
  });

  describe('malformed input', () => {
    const now = ONE_CAPABILITY.signedAtMs;
    const token = Buffer.from(ONE_CAPABILITY.hex, 'hex');

    it.each([0, 1, 64, 74, 75, 114, 115])('rejects %i bytes without throwing', (length) => {
      expect(verifyRingToken(new Uint8Array(token.subarray(0, length)), now)).toEqual({
        ok: false,
        error: 'malformed',
      });
    });

    it('rejects a truncated capability list', () => {
      expect(verifyRingToken(new Uint8Array(token.subarray(0, token.length - 1)), now)).toEqual({
        ok: false,
        error: 'malformed',
      });
    });

    it('rejects trailing bytes after the capability list', () => {
      expect(verifyRingToken(new Uint8Array(Buffer.concat([token, Buffer.from([0])])), now)).toEqual({
        ok: false,
        error: 'malformed',
      });
    });

    it('rejects input above the size limit', () => {
      expect(verifyRingToken(new Uint8Array(MAX_TOKEN_LENGTH + 1), now)).toEqual({ ok: false, error: 'malformed' });
    });

    it('rejects a padded length prefix', () => {
      // 0x80 0x00 is a two-byte spelling of zero.
      const head = Buffer.from(NO_CAPABILITIES.hex, 'hex').subarray(0, 115);
      const padded = new Uint8Array(Buffer.concat([head, Buffer.from([0x80, 0x00])]));
      expect(verifyRingToken(padded, NO_CAPABILITIES.signedAtMs)).toEqual({ ok: false, error: 'malformed' });
    });

    it('rejects all-zero input of a plausible length', () => {
      expect(verifyRingToken(new Uint8Array(179), now).ok).toBe(false);
    });
  });
});

describe('degenerate keys', () => {
  // Under a small-order public key, a signature of the identity point and
  // zero satisfies the Ed25519 equation for every message, unless the
  // verifier refuses such keys. This would let anyone sign in as an admin
  // whose configured key is one of them, so it must stay refused whatever
  // crypto library Node is built against.
  const IDENTITY = Buffer.concat([Buffer.from([1]), Buffer.alloc(31)]);
  const SMALL_ORDER_KEYS = [
    ['the identity point', IDENTITY],
    ['the all-zero key', Buffer.alloc(32)],
    ['the point of order 2', Buffer.concat([Buffer.from([0xec]), Buffer.alloc(30, 0xff), Buffer.from([0x7f])])],
  ] as const;

  it.each(SMALL_ORDER_KEYS)('refuses the universal forgery under %s', (_name, key) => {
    const body = Buffer.from(NO_CAPABILITIES.hex, 'hex').subarray(64);
    for (const r of [IDENTITY, key]) {
      const forged = Buffer.concat([r, Buffer.alloc(32), body]);
      forged.set(key, 83);
      expect(verifyRingToken(new Uint8Array(forged), NO_CAPABILITIES.signedAtMs).ok).toBe(false);
    }
  });
});

describe('pubky keys', () => {
  it('formats the signer of the real tokens the way pubky-common does', () => {
    expect(formatPubky(Buffer.from(SIGNER_HEX, 'hex'))).toBe(SIGNER_Z32);
  });

  it('parses a key with or without the pubky prefix', () => {
    expect(parsePubky(SIGNER_Z32)?.toString('hex')).toBe(SIGNER_HEX);
    expect(parsePubky(`pubky${SIGNER_Z32}`)?.toString('hex')).toBe(SIGNER_HEX);
  });

  it('round-trips arbitrary keys', () => {
    for (const fill of [0x00, 0xff, 0x5a, 0x01, 0x80]) {
      const key = Buffer.alloc(32, fill);
      expect(parsePubky(formatPubky(key))).toEqual(key);
    }
  });

  it('does not strip "pubky" from a key that merely starts with those letters', () => {
    // All five letters are in the z-base-32 alphabet, so this is a legal key.
    const startsWithPubky = `pubky${'y'.repeat(47)}`;
    const key = parsePubky(startsWithPubky);
    expect(key).not.toBeNull();
    expect(formatPubky(key!)).toBe(startsWithPubky);
  });

  it.each([
    ['empty', ''],
    ['too short', SIGNER_Z32.slice(1)],
    ['too long', `${SIGNER_Z32}y`],
    ['uppercase', SIGNER_Z32.toUpperCase()],
    ['a character outside the alphabet', `l${SIGNER_Z32.slice(1)}`],
    ['surrounding whitespace', ` ${SIGNER_Z32}`],
    ['a prefix other than pubky', `pubkx${SIGNER_Z32}`],
    // Same 32 bytes, but with spare bits set in the last character.
    ['a non-canonical spelling of a real key', `${SIGNER_Z32.slice(0, 51)}n`],
  ])('rejects %s', (_case, text) => {
    expect(parsePubky(text)).toBeNull();
  });
});
