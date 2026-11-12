/** Display helpers for what the homeserver reports about invite codes and users. */

/** A shortened pubky for lists: the first 8 and last 6 characters. */
export function shortPubky(pubky: string): string {
  return pubky.length > 16 ? `${pubky.slice(0, 8)}…${pubky.slice(-6)}` : pubky;
}

/**
 * The homeserver's signup-code timestamps are UTC without a zone
 * ("2026-10-14T13:17:43.385"); shown in the viewer's local time.
 */
export function formatUtcTimestamp(value: string): string {
  const date = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Bytes as people read them: 0 B, 12 KB, 4.3 MB, 1.2 GB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/** A storage allowance in MB as people read it: "500 MB", "1.5 GB", "unlimited". */
export function formatStorageMb(mb: number | 'unlimited' | undefined): string {
  if (mb === undefined || mb === 'unlimited') return 'unlimited';
  if (mb < 1024) return `${mb} MB`;
  const gb = mb / 1024;
  return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
}

/** Percent of a storage allowance in MB that is used, 0 to 100; null where there is no limit. */
export function usedPercent(usedBytes: number, limitMb: number | 'unlimited' | undefined): number | null {
  if (typeof limitMb !== 'number') return null;
  if (limitMb === 0) return 100;
  return Math.min(100, Math.round((usedBytes / (limitMb * 1024 * 1024)) * 100));
}

/** What an account stores against its allowance: "30 KB of 500 MB (6%)", or "30 KB, no limit". */
export function formatUsage(usedBytes: number, limitMb: number | 'unlimited' | undefined): string {
  const share = usedPercent(usedBytes, limitMb);
  if (share === null) return `${formatBytes(usedBytes)}, no limit`;
  return `${formatBytes(usedBytes)} of ${formatStorageMb(limitMb)} (${share}%)`;
}
