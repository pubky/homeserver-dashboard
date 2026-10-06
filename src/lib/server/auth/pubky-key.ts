/**
 * A pubky is an Ed25519 public key written as 52 z-base-32 characters,
 * sometimes with a `pubky` prefix. This module converts between that text and
 * the 32 raw bytes, strictly: admin keys are an access-control list, so a
 * value that is not exactly one canonical key is rejected, never repaired.
 */

const Z32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';
const KEY_BYTES = 32;
const KEY_CHARS = 52;
const PREFIX = 'pubky';

/** The z-base-32 text of a 32-byte public key (no prefix). */
export function formatPubky(key: Uint8Array): string {
  if (key.length !== KEY_BYTES) throw new Error('a public key is 32 bytes');
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const byte of key) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += Z32_ALPHABET[(acc >>> bits) & 31];
    }
    acc &= (1 << bits) - 1;
  }
  // 256 bits leave 1 bit over; it is the high bit of the last character.
  if (bits > 0) out += Z32_ALPHABET[(acc << (5 - bits)) & 31];
  return out;
}

/**
 * The 32 bytes of a pubky, or null when `text` is not exactly one key.
 * Accepts the `pubky` prefix. The z-base-32 alphabet contains the letters of
 * "pubky", so the prefix is only stripped from a value of the prefixed length.
 */
export function parsePubky(text: string): Buffer | null {
  const z32 = text.length === PREFIX.length + KEY_CHARS && text.startsWith(PREFIX) ? text.slice(PREFIX.length) : text;
  if (z32.length !== KEY_CHARS) return null;

  const key = Buffer.alloc(KEY_BYTES);
  let acc = 0;
  let bits = 0;
  let written = 0;
  for (const ch of z32) {
    const value = Z32_ALPHABET.indexOf(ch);
    if (value === -1) return null;
    acc = (acc << 5) | value;
    bits += 5;
    if (bits >= 8 && written < KEY_BYTES) {
      bits -= 8;
      key[written++] = (acc >>> bits) & 0xff;
    }
    acc &= (1 << bits) - 1;
  }
  // 52 characters carry 260 bits; the 4 spare ones must be zero, or two
  // different strings would name the same key.
  if (written !== KEY_BYTES || formatPubky(key) !== z32) return null;
  return key;
}
