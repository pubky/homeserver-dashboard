import { Z32_PUBKEY_PATTERN } from './pubky';

/** What the admin delete takes: a user's pubky, then a path under /pub/. */
const ENTRY_PATH = new RegExp(`^${Z32_PUBKEY_PATTERN}/pub/.+`);

/**
 * The entry path in what an admin typed or pasted: a bare entry path, a
 * `/dav/...` or `/webdav/...` path, or a full URL to one. Null when it holds none.
 */
export function parseEntryPath(input: string): string | null {
  let value = input.trim();

  if (/^https?:\/\//i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      // Not a URL after all: read it as a path.
    }
  }

  for (const marker of ['/dav/', '/webdav/']) {
    if (value.includes(marker)) value = value.split(marker).slice(1).join(marker);
  }
  value = value.replace(/^\/+/, '').replace(/^(web)?dav\/+/, '');

  return ENTRY_PATH.test(value) ? value : null;
}
