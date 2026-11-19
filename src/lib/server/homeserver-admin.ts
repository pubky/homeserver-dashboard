import { promises as fs } from 'fs';
import { parse as parseToml } from 'smol-toml';

/** How to reach the homeserver's admin API. A part that is not configured anywhere is undefined. */
type HomeserverAdmin = { baseUrl?: string; token?: string };

// The default is where the Docker image mounts the homeserver's data.
const configPath = () => process.env.HOMESERVER_CONFIG_PATH || '/app/homeserver-data/config.toml';

// What the homeserver uses when its config does not say. A fresh config.toml
// has every setting commented out, so this is the common case. The password is
// no secret: it is the homeserver's published default, and the dashboard warns
// whenever it has to fall back on it.
const DEFAULT_LISTEN_SOCKET = '127.0.0.1:6288';
const DEFAULT_ADMIN_PASSWORD = 'admin';

// The last problem with the config that was logged, so that the dashboard
// says so once and not on every request.
let reportedProblem: string | null = null;

/**
 * Logs what is wrong with the config: its path and the kind of problem, never
 * anything from the file, which holds the admin password.
 */
function reportConfigProblem(path: string, problem: string) {
  const report = `${path}: ${problem}`;
  if (report === reportedProblem) return;
  reportedProblem = report;
  console.warn({
    timestamp: new Date().toISOString(),
    level: 'warn',
    message: "The homeserver's config.toml, read for the admin API's settings",
    meta: { path, problem },
  });
}

/**
 * The `[admin]` table of the homeserver's config.toml: empty when the config
 * has none, null when the file cannot be read or parsed.
 */
async function adminSectionOfConfig(): Promise<Record<string, unknown> | null> {
  const path = configPath();
  let content: string;
  try {
    content = await fs.readFile(path, 'utf-8');
  } catch (error) {
    reportConfigProblem(path, `cannot be read (${(error as NodeJS.ErrnoException).code ?? 'unreadable'})`);
    return null;
  }
  let config: Record<string, unknown>;
  try {
    config = parseToml(content) as Record<string, unknown>;
  } catch {
    // The parser's message quotes the offending line, which may be the password's.
    reportConfigProblem(path, 'is not valid TOML');
    return null;
  }
  const admin = config.admin;
  return typeof admin === 'object' && admin !== null ? (admin as Record<string, unknown>) : {};
}

/**
 * The address to call for a `listen_socket` such as "127.0.0.1:6288". The
 * homeserver may listen on every interface ("0.0.0.0", "[::]"); the dashboard
 * runs next to it, so it calls loopback then.
 */
function baseUrlOf(listenSocket: unknown): string | undefined {
  if (typeof listenSocket !== 'string') return undefined;
  const socket = listenSocket
    .trim()
    .replace(/^0\.0\.0\.0:/, '127.0.0.1:')
    .replace(/^\[::\]:/, '[::1]:');
  // A socket address always names its port; `URL` alone would accept a bare host.
  if (!/:\d+$/.test(socket)) return undefined;
  try {
    return new URL(`http://${socket}`).origin;
  } catch {
    return undefined;
  }
}

/**
 * The password the homeserver's admin API expects, from its `[admin]` table:
 * the one it sets, or the homeserver's default when it sets none. A value the
 * homeserver could not be using (empty, or not text) gives nothing.
 */
function passwordOf(admin: Record<string, unknown>): string | undefined {
  const password = admin.admin_password;
  if (password === undefined) {
    reportConfigProblem(
      configPath(),
      `sets no [admin] admin_password, so the homeserver's default ("${DEFAULT_ADMIN_PASSWORD}") is used; set one`,
    );
    return DEFAULT_ADMIN_PASSWORD;
  }
  reportedProblem = null;
  return typeof password === 'string' && password !== '' ? password : undefined;
}

/**
 * The admin API's address and password: ADMIN_BASE_URL and ADMIN_TOKEN when
 * set, and for whichever is not, what the homeserver's own config.toml says
 * (`[admin]` `listen_socket` and `admin_password`). A dashboard that runs next
 * to a homeserver therefore needs only HOMESERVER_CONFIG_PATH. A variable that
 * is set always wins, and with both set the file is not read at all.
 *
 * A readable config that leaves either out means the homeserver's default for
 * it, as the homeserver itself would use: its default address, and its default
 * password, which is well known, so falling back on it is logged as a warning.
 *
 * Read on every call, like the rest of the environment: a changed password
 * is picked up without restarting the dashboard. The other side of that: the
 * homeserver reads its config only when it starts, so between an edit of
 * these two settings and the homeserver's restart the dashboard already uses
 * the new values and its admin calls fail.
 */
export async function homeserverAdmin(): Promise<HomeserverAdmin> {
  const baseUrl = process.env.ADMIN_BASE_URL || undefined;
  const token = process.env.ADMIN_TOKEN || undefined;
  if (baseUrl && token) return { baseUrl, token };

  const admin = await adminSectionOfConfig();
  return {
    baseUrl: baseUrl ?? (admin ? baseUrlOf(admin.listen_socket ?? DEFAULT_LISTEN_SOCKET) : undefined),
    token: token ?? (admin ? passwordOf(admin) : undefined),
  };
}
