/** Display helpers for what the homeserver reports about invite codes. */

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
