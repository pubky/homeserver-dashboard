import { describe, expect, it } from 'vitest';
import { defaultText, describeLimits, emptyQuotaText, quotaLimits, quotaPatch, quotaText } from './quota-form';

const loaded = quotaText({ storage_quota_mb: 500, allowed_write_paths: ['/pub/app/'] });

describe('quotaText', () => {
  it('shows overrides as text and leaves the rest empty', () => {
    expect(loaded).toEqual({
      storage_quota_mb: '500',
      rate_read: '',
      rate_write: '',
      rate_read_burst: '',
      rate_write_burst: '',
      allowed_write_paths: '/pub/app/',
    });
  });

  it('shows read-only as none', () => {
    expect(quotaText({ allowed_write_paths: [] }).allowed_write_paths).toBe('none');
  });
});

describe('defaultText', () => {
  it('describes what an empty field falls back to', () => {
    expect(defaultText('storage_quota_mb', { storage_quota_mb: 1024 })).toBe('1024');
    expect(defaultText('rate_read', {})).toBe('unlimited');
    expect(defaultText('rate_read_burst', {})).toBe('same as rate');
    expect(defaultText('rate_read_burst', { rate_read_burst: 20 })).toBe('20');
    expect(defaultText('allowed_write_paths', {})).toBe('anywhere');
  });
});

describe('quotaPatch', () => {
  it('sends only the fields that changed', () => {
    expect(quotaPatch(loaded, { ...loaded, rate_read: '10MB/s', rate_read_burst: '50' })).toEqual({
      rate_read: '10mb/s',
      rate_read_burst: 50,
    });
  });

  it('turns a cleared field into null, back to the default', () => {
    expect(quotaPatch(loaded, { ...loaded, storage_quota_mb: '' })).toEqual({ storage_quota_mb: null });
    expect(quotaPatch(loaded, { ...loaded, storage_quota_mb: 'default' })).toEqual({ storage_quota_mb: null });
  });

  it('reads unlimited, read-only and path lists', () => {
    expect(
      quotaPatch(loaded, { ...loaded, storage_quota_mb: 'Unlimited', allowed_write_paths: ' /pub/a/, /pub/b/ ,' }),
    ).toEqual({ storage_quota_mb: 'unlimited', allowed_write_paths: ['/pub/a/', '/pub/b/'] });
    expect(quotaPatch(loaded, { ...loaded, allowed_write_paths: 'none' })).toEqual({ allowed_write_paths: [] });
  });

  it('rejects storage and bursts that are not whole numbers', () => {
    expect(() => quotaPatch(loaded, { ...loaded, storage_quota_mb: '1.5' })).toThrow(/whole number of MB/);
    expect(() => quotaPatch(loaded, { ...loaded, rate_write_burst: '0' })).toThrow(/above zero/);
  });

  it('refuses an empty change', () => {
    expect(() => quotaPatch(loaded, { ...loaded, storage_quota_mb: ' 500 ' })).toThrow('Nothing changed.');
  });
});

describe('quotaLimits', () => {
  it('parses the filled-in fields and leaves the rest out', () => {
    expect(quotaLimits({ ...emptyQuotaText(), storage_quota_mb: '500', allowed_write_paths: 'none' })).toEqual({
      storage_quota_mb: 500,
      allowed_write_paths: [],
    });
    expect(quotaLimits(emptyQuotaText())).toEqual({});
  });

  it('reads rates, unlimited, default and path lists', () => {
    expect(
      quotaLimits({
        ...emptyQuotaText(),
        storage_quota_mb: 'Unlimited',
        rate_read: '10MB/s',
        rate_read_burst: '50',
        rate_write: 'default',
        allowed_write_paths: ' /pub/a/, /pub/b/ ,',
      }),
    ).toEqual({
      storage_quota_mb: 'unlimited',
      rate_read: '10mb/s',
      rate_read_burst: 50,
      allowed_write_paths: ['/pub/a/', '/pub/b/'],
    });
  });

  it('rejects what it cannot read', () => {
    expect(() => quotaLimits({ ...emptyQuotaText(), rate_read_burst: 'lots' })).toThrow(/above zero/);
    expect(() => quotaLimits({ ...emptyQuotaText(), rate_write_burst: '0' })).toThrow(/above zero/);
    expect(() => quotaLimits({ ...emptyQuotaText(), storage_quota_mb: '1.5' })).toThrow(/whole number of MB/);
    expect(() => quotaLimits({ ...emptyQuotaText(), allowed_write_paths: ' , ,' })).toThrow(/at least one path/);
  });
});

describe('describeLimits', () => {
  it('reads each limit back in words', () => {
    expect(
      describeLimits({ storage_quota_mb: 500, rate_read: '10mb/s', rate_read_burst: 50, allowed_write_paths: [] }),
    ).toEqual(['Storage: 500 MB', 'Writable paths: none (read-only)', 'Download rate: 10mb/s', 'Download burst: 50']);
    expect(describeLimits({ storage_quota_mb: 'unlimited', allowed_write_paths: ['/pub/a/'] })).toEqual([
      'Storage: unlimited',
      'Writable paths: /pub/a/',
    ]);
    expect(describeLimits({ storage_quota_mb: 2048 })).toEqual(['Storage: 2 GB']);
    expect(describeLimits({})).toEqual([]);
  });
});
