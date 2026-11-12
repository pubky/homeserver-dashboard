/**
 * A form's quota fields: how a limit is shown as text, and how the text typed
 * into a field becomes a limit or a PATCH. An empty field means "homeserver
 * default".
 */
import type { UserQuota, UserQuotaPatch } from '@/services/admin/admin.types';

type QuotaField = keyof UserQuota;

type QuotaFieldSpec = { key: QuotaField; label: string; hint: string };

export const QUOTA_FIELDS: QuotaFieldSpec[] = [
  // In pairs: the form lays them out two to a row, a rate beside its burst.
  { key: 'storage_quota_mb', label: 'Storage (MB)', hint: 'Whole MB, or unlimited.' },
  {
    key: 'allowed_write_paths',
    label: 'Writable paths',
    hint: 'Comma-separated, e.g. /pub/my-app/. none = read-only. Empty = anywhere.',
  },
  { key: 'rate_read', label: 'Download rate', hint: 'For example 10mb/s or 500kb/s, or unlimited.' },
  { key: 'rate_read_burst', label: 'Download burst', hint: "In the rate's unit. Needs a custom download rate." },
  { key: 'rate_write', label: 'Upload rate', hint: 'For example 5mb/s, or unlimited.' },
  { key: 'rate_write_burst', label: 'Upload burst', hint: "In the rate's unit. Needs a custom upload rate." },
];

export type QuotaText = Record<QuotaField, string>;

/** One quota value as editable text; '' for a field with no value. */
function quotaValueText(key: QuotaField, value: UserQuota[QuotaField] | undefined): string {
  if (value === undefined || value === null) return '';
  if (key === 'allowed_write_paths') {
    const paths = value as string[];
    return paths.length === 0 ? 'none' : paths.join(', ');
  }
  return String(value);
}

/** The form's fields for a user's overrides. */
export function quotaText(overrides: UserQuota): QuotaText {
  const text = {} as QuotaText;
  for (const { key } of QUOTA_FIELDS) text[key] = quotaValueText(key, overrides[key]);
  return text;
}

/** How an empty field reads, from the limits that apply when it is left empty. */
export function defaultText(key: QuotaField, effective: UserQuota): string {
  if (key === 'allowed_write_paths')
    return effective.allowed_write_paths ? quotaValueText(key, effective[key]) : 'anywhere';
  const value = quotaValueText(key, effective[key]);
  if (value !== '') return value;
  return key === 'rate_read_burst' || key === 'rate_write_burst' ? 'same as rate' : 'unlimited';
}

const WHOLE_NUMBER = /^\d+$/;

/** The paths in a comma-separated list. An empty list would mean read-only, which only `none` may say. */
function writablePaths(text: string): string[] {
  const paths = text
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);
  if (paths.length === 0) throw new Error('Writable paths must name at least one path, or none for read-only.');
  return paths;
}

/** Parses one field; null = the homeserver default. Throws a readable error. */
function parseField(key: QuotaField, raw: string): UserQuota[QuotaField] | null {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (text === '' || lower === 'default') return null;
  switch (key) {
    case 'storage_quota_mb':
      if (lower === 'unlimited') return 'unlimited';
      if (WHOLE_NUMBER.test(text)) return Number(text);
      throw new Error('Storage must be a whole number of MB, or unlimited.');
    case 'rate_read':
    case 'rate_write':
      // The homeserver checks the format and says what is wrong.
      return lower === 'unlimited' ? 'unlimited' : lower;
    case 'rate_read_burst':
    case 'rate_write_burst':
      if (WHOLE_NUMBER.test(text) && Number(text) > 0) return Number(text);
      throw new Error('A burst must be a whole number above zero.');
    case 'allowed_write_paths':
      if (lower === 'none') return [];
      return writablePaths(text);
  }
}

/**
 * The limits for a new invite: every filled-in field, parsed. Empty fields
 * (the homeserver default) are left out. Throws when a field cannot be read.
 */
export function quotaLimits(text: QuotaText): UserQuota {
  const limits: UserQuota = {};
  for (const { key } of QUOTA_FIELDS) {
    const value = parseField(key, text[key]);
    if (value !== null) (limits as Record<QuotaField, unknown>)[key] = value;
  }
  return limits;
}

/** Each limit as people read it, e.g. "Storage 500 MB", "Writable paths: none (read-only)". */
export function describeLimits(limits: UserQuota): string[] {
  const lines: string[] = [];
  for (const { key, label } of QUOTA_FIELDS) {
    const value = limits[key];
    if (value === undefined) continue;
    if (key === 'allowed_write_paths') {
      const paths = value as string[];
      lines.push(paths.length === 0 ? `${label}: none (read-only)` : `${label}: ${paths.join(', ')}`);
    } else if (key === 'storage_quota_mb') {
      lines.push(`Storage: ${value === 'unlimited' ? 'unlimited' : `${value} MB`}`);
    } else {
      lines.push(`${label}: ${value}`);
    }
  }
  return lines;
}

/** The form's fields all empty: every limit at the homeserver default. */
export function emptyQuotaText(): QuotaText {
  return quotaText({});
}

/**
 * The PATCH for the fields whose text changed since `loaded`; a cleared field
 * becomes null, back to the homeserver default. Throws when a changed field
 * cannot be read, or when nothing changed.
 */
export function quotaPatch(loaded: QuotaText, edited: QuotaText): UserQuotaPatch {
  const patch: UserQuotaPatch = {};
  for (const { key } of QUOTA_FIELDS) {
    if (edited[key].trim() === loaded[key].trim()) continue;
    (patch as Record<QuotaField, unknown>)[key] = parseField(key, edited[key]);
  }
  if (Object.keys(patch).length === 0) throw new Error('Nothing changed.');
  return patch;
}
