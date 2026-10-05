import { promises as fs } from 'fs';
import { parse as parseToml } from 'smol-toml';

// Env is read lazily (call time, not module load), following the convention
// in cloudflared-process.ts.
const getConfigPath = () => process.env.HOMESERVER_CONFIG_PATH || '/app/homeserver-data/config.toml';

async function readPasswordFromConfig(): Promise<string | undefined> {
  try {
    const config = parseToml(await fs.readFile(getConfigPath(), 'utf-8'));
    const admin = config.admin;
    if (!admin || typeof admin !== 'object' || Array.isArray(admin)) return undefined;
    const password = (admin as Record<string, unknown>).admin_password;
    return typeof password === 'string' && password !== '' ? password : undefined;
  } catch {
    // No file, not readable, or not TOML: same as "not configured".
    return undefined;
  }
}

/**
 * The password the dashboard sends to the homeserver's admin API.
 *
 * `ADMIN_TOKEN` wins when it is set (the Docker and Umbrel deployments pass
 * it). Otherwise the password is taken from `[admin] admin_password` in the
 * homeserver's own config.toml, which is where the homeserver reads it from,
 * so an install that can see that file keeps the password in one place.
 *
 * The file is read on every call, never cached: a password changed in
 * config.toml is picked up without restarting the dashboard.
 */
export async function getAdminToken(): Promise<string | undefined> {
  return process.env.ADMIN_TOKEN || (await readPasswordFromConfig());
}
