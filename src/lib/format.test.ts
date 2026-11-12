import { describe, expect, it } from 'vitest';
import { formatUtcTimestamp, shortPubky } from './format';

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
