import { parsePubky } from './pubky-key';

/**
 * Whether the dashboard asks for a sign-in, and who may sign in.
 *
 *   off      ADMIN_PUBKEYS is not set: no sign-in, as before. Right only where
 *            something in front of the dashboard authenticates (Umbrel's app
 *            proxy) or only admins can reach its port.
 *   on       ADMIN_PUBKEYS lists the pubkys that may sign in with Pubky Ring.
 *   invalid  ADMIN_PUBKEYS is set but unusable. Everything is refused until
 *            it is fixed: a typo must never fall back to "no sign-in".
 */
export type ActiveAuthConfig = { mode: 'on'; admins: Buffer[]; relay: string | null };
export type AuthConfig = { mode: 'off' } | ActiveAuthConfig | { mode: 'invalid'; reason: string };

function isHttpUrl(value: string): boolean {
  try {
    return ['https:', 'http:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** Read from the environment on every call, like every other setting here. */
export function getAuthConfig(): AuthConfig {
  const raw = process.env.ADMIN_PUBKEYS;
  // Only "not set at all" means off. An empty value is a mistake (a template
  // that rendered nothing), and must not open the dashboard.
  if (raw === undefined) return { mode: 'off' };

  const entries = raw.split(/[\s,]+/).filter((entry) => entry !== '');
  if (entries.length === 0) return { mode: 'invalid', reason: 'ADMIN_PUBKEYS is set but lists no pubky' };

  const admins: Buffer[] = [];
  for (const [index, entry] of entries.entries()) {
    const key = parsePubky(entry);
    if (!key) return { mode: 'invalid', reason: `ADMIN_PUBKEYS entry ${index + 1} is not a pubky` };
    if (!admins.some((known) => known.equals(key))) admins.push(key);
  }

  const relay = process.env.AUTH_RELAY?.trim() || null;
  if (relay && !isHttpUrl(relay)) return { mode: 'invalid', reason: 'AUTH_RELAY is not an http(s) URL' };

  return { mode: 'on', admins, relay };
}

export function isAdminKey(config: ActiveAuthConfig, key: Buffer): boolean {
  return config.admins.some((admin) => admin.equals(key));
}
