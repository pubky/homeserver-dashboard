import { describe, expect, it } from 'vitest';
import { parseEntryPath } from './entry-path';

const USER = 'o4dksfbqk85ogzdb5osziw6befigbuxmuxkuxq8434q89uj56uyy';
const ENTRY = `${USER}/pub/dir/file.txt`;

describe('parseEntryPath', () => {
  it.each([[`${USER}/pub/a%23b%3F.txt`], [`${USER}/pub/..hidden/a..b.txt`]])('keeps %s as it is', (input) => {
    expect(parseEntryPath(input)).toBe(input);
  });

  it.each([
    [ENTRY],
    [`  /${ENTRY}  `],
    [`/dav/${ENTRY}`],
    [`dav/${ENTRY}`],
    [`/webdav/${ENTRY}`],
    [`https://admin.example.com/dav/${ENTRY}`],
    [`http://127.0.0.1:6288/webdav/${ENTRY}`],
  ])('reads the entry path out of %s', (input) => {
    expect(parseEntryPath(input)).toBe(ENTRY);
  });

  it.each([
    [''],
    ['   '],
    ['garbage'],
    ['pk1/pub/file.txt'],
    [`${USER}`],
    [`${USER}/`],
    [`${USER}/pub/`],
    [`${USER}/notes.txt`],
    // `l` is not in the z-base-32 alphabet.
    [`${USER.replace('o', 'l')}/pub/file.txt`],
    [`https://example.com/${USER}`],
    // A browser would send a different path than the one shown.
    [`${USER}/pub/dir/#notes`],
    [`${USER}/pub/file.txt?x`],
    [`${USER}/pub/dir/../file.txt`],
    [`${USER}/pub/./file.txt`],
    [`${USER}/pub/dir/..`],
    [`${USER}/pub/dir\\file.txt`],
  ])('finds no entry path in %j', (input) => {
    expect(parseEntryPath(input)).toBeNull();
  });
});
