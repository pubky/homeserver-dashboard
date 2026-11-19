import { describe, expect, it } from 'vitest';
import { formatBytes, formatStorageMb, formatUsage, formatUtcTimestamp, shortPubky, usedPercent } from './format';

describe('shortPubky', () => {
  it('keeps the ends of a long key', () => {
    expect(shortPubky('8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo')).toBe('8pinxxgq…435ewo');
    expect(shortPubky('short')).toBe('short');
  });
});

describe('formatUtcTimestamp', () => {
  it('reads a zone-less timestamp as UTC', () => {
    expect(formatUtcTimestamp('2026-10-14T13:17:43.385')).toBe(new Date('2026-10-14T13:17:43.385Z').toLocaleString());
  });

  it('keeps an explicit zone', () => {
    expect(formatUtcTimestamp('2026-10-14T13:17:43+02:00')).toBe(new Date('2026-10-14T11:17:43Z').toLocaleString());
  });

  it('passes through what it cannot read', () => {
    expect(formatUtcTimestamp('yesterday')).toBe('yesterday');
  });
});

describe('formatBytes', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1.0 KB'],
    [30521, '30 KB'],
    [4.3 * 1024 * 1024, '4.3 MB'],
    [1.2 * 1024 ** 3, '1.2 GB'],
  ])('%s -> %s', (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });
});

describe('formatStorageMb', () => {
  it.each([
    [500, '500 MB'],
    [1024, '1 GB'],
    [1536, '1.5 GB'],
    ['unlimited' as const, 'unlimited'],
    [undefined, 'unlimited'],
  ])('%j -> %j', (mb, expected) => {
    expect(formatStorageMb(mb)).toBe(expected);
  });
});

describe('formatUsage', () => {
  it('sets what is stored against the allowance', () => {
    expect(formatUsage(30 * 1024 * 1024, 500)).toBe('30 MB of 500 MB (6%)');
    expect(formatUsage(2 * 1024 ** 3, 1024)).toBe('2.0 GB of 1 GB (100%)');
  });

  it('says so when there is no limit', () => {
    expect(formatUsage(30521, 'unlimited')).toBe('30 KB, no limit');
    expect(formatUsage(30521, undefined)).toBe('30 KB, no limit');
    expect(usedPercent(30521, 'unlimited')).toBeNull();
  });

  it('reads an allowance of nothing as full, not as no limit', () => {
    expect(formatUsage(30521, 0)).toBe('30 KB of 0 MB (100%)');
    expect(formatUsage(0, 0)).toBe('0 B of 0 MB (100%)');
  });
});
