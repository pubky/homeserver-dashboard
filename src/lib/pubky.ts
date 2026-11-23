/** The z-base-32 alphabet a pubky is written in. */
export const Z32_ALPHABET = 'ybndrfg8ejkmcpqxot1uwisza345h769';

/** A pubky as text, 52 z-base-32 characters: regular-expression source, for building larger patterns. */
export const Z32_PUBKEY_PATTERN = `[${Z32_ALPHABET}]{52}`;

export const Z32_PUBKEY_RE = new RegExp(`^${Z32_PUBKEY_PATTERN}$`);
