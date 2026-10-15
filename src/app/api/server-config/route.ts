import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { parse as parseToml } from 'smol-toml';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';
import { restartAppSentence } from '@/lib/restart-copy';
import { getPlatform } from '@/lib/server/platform';

// Env is read lazily (call time, not module load), following the convention
// in cloudflared-process.ts, so tests and multi-env deployments are never
// frozen to a stale value.
const getConfigPath = () => process.env.HOMESERVER_CONFIG_PATH || '/app/homeserver-data/config.toml';
const ROUTE_NAME = '/api/server-config';
const REDACTION_TOKEN = '********';

// Top-level TOML tables that must be present for Pubky Homeserver to boot.
// Validated structurally on POST so the dashboard refuses to write a config
// that the homeserver can't load. We don't validate values - Pubky Homeserver does
// that on startup.
const REQUIRED_SECTIONS = ['general', 'drive', 'admin', 'storage'];

// Keys whose value is masked on GET and restored on POST (see
// `restoreRedactedValues`). Strings only; nested/array secrets aren't a thing
// in the current config shape.
const SENSITIVE_KEYS = ['admin_password', 'database_url'];

const REDACT_PATTERNS = SENSITIVE_KEYS.map((k) => new RegExp(`^${k}\\s*=\\s*".*"`));

function redactConfig(content: string): string {
  return content
    .split('\n')
    .map((line) => {
      for (const pattern of REDACT_PATTERNS) {
        if (pattern.test(line.trim())) {
          const key = line.split('=')[0];
          return `${key}= "${REDACTION_TOKEN}"`;
        }
      }
      return line;
    })
    .join('\n');
}

function computeChecksum(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex');
}

function extractStringValue(trimmedLine: string, key: string): string | null {
  const m = trimmedLine.match(new RegExp(`^${key}\\s*=\\s*"(.*)"`));
  return m ? m[1] : null;
}

/**
 * The GET handler returns `admin_password = "********"` and `database_url = "********"`.
 * If a client edits an unrelated line in that redacted view and POSTs the
 * whole thing back, we'd otherwise write the literal "********" as the
 * password and lose the real secret. For each sensitive line in the incoming
 * payload whose value is exactly the redaction token, substitute the
 * corresponding line from the existing on-disk file.
 *
 * If a sensitive key was removed from the incoming payload entirely, that's
 * accepted as-is (the user explicitly cleared it). Only the placeholder
 * round-trip is what we protect against.
 */
function restoreRedactedValues(incoming: string, existing: string): string {
  const originalLines = new Map<string, string>();
  for (const line of existing.split('\n')) {
    const trimmed = line.trim();
    for (const key of SENSITIVE_KEYS) {
      if (!originalLines.has(key) && extractStringValue(trimmed, key) !== null) {
        originalLines.set(key, line);
      }
    }
  }
  return incoming
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      for (const key of SENSITIVE_KEYS) {
        if (extractStringValue(trimmed, key) === REDACTION_TOKEN) {
          const original = originalLines.get(key);
          if (original) return original;
        }
      }
      return line;
    })
    .join('\n');
}

function validateTomlStructure(toml: string): RouteError | null {
  let parsed: unknown;
  try {
    parsed = parseToml(toml);
  } catch (e) {
    return new RouteError(400, 'bad_request', 'Invalid TOML: ' + (e instanceof Error ? e.message : String(e)));
  }
  if (!parsed || typeof parsed !== 'object') {
    return new RouteError(400, 'bad_request', 'Config must be a TOML table');
  }
  const root = parsed as Record<string, unknown>;
  for (const section of REQUIRED_SECTIONS) {
    if (!(section in root) || typeof root[section] !== 'object' || root[section] === null) {
      return new RouteError(400, 'bad_request', `Missing required section: [${section}]`);
    }
  }
  return null;
}

/**
 * GET /api/server-config
 * Returns the homeserver config.toml with sensitive fields redacted, plus
 * the SHA-256 checksum of the raw file (for optimistic concurrency on POST),
 * mtime (for the "differs from running" indicator), and whether the file is
 * writable (drives whether the UI shows the edit affordance).
 */
export async function GET() {
  const requestId = randomUUID();
  const startedAt = Date.now();
  const configPath = getConfigPath();
  try {
    // Single fd for everything: stat, read, and writability probe all happen
    // against the same inode, so we cannot race with a concurrent rename or
    // chmod. The open mode also IS the writability check: O_RDWR succeeds iff
    // we can also save, no separate fs.access call needed (CodeQL flagged the
    // multi-call pattern as a TOCTOU).
    let fh: Awaited<ReturnType<typeof fs.open>>;
    let writable = false;
    let writableError: string | undefined;
    try {
      fh = await fs.open(configPath, 'r+');
      writable = true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw err; // bubble to the outer 404 branch
      writableError = code ?? 'UNKNOWN';
      fh = await fs.open(configPath, 'r');
    }

    try {
      const stat = await fh.stat();
      const buf = Buffer.alloc(stat.size);
      await fh.read(buf, 0, stat.size, 0);
      const raw = buf.toString('utf-8');

      // Capability diagnostics. Useful for the operator to debug a stuck
      // "Read-only" badge: compare process uid/gid with the file's, decode
      // mode, see the exact errno. None of these are secrets - they are the
      // identity of the running container and the bind-mounted file.
      const diagnostics = {
        process: {
          uid: typeof process.getuid === 'function' ? process.getuid() : null,
          gid: typeof process.getgid === 'function' ? process.getgid() : null,
        },
        file: {
          path: configPath,
          uid: stat.uid,
          gid: stat.gid,
          mode: '0' + (stat.mode & 0o7777).toString(8),
        },
        writable_error: writableError,
      };

      const checksum = computeChecksum(raw);
      logRouteInfo({
        requestId,
        route: ROUTE_NAME,
        method: 'GET',
        statusCode: 200,
        durationMs: Date.now() - startedAt,
        message: 'Server config read',
        meta: { writable, writableError },
      });
      return NextResponse.json({
        config: redactConfig(raw),
        checksum,
        mtime: stat.mtime.toISOString(),
        writable,
        diagnostics,
        requestId,
      });
    } finally {
      await fh.close();
    }
  } catch (e: unknown) {
    const isNotFound = (e as NodeJS.ErrnoException).code === 'ENOENT';
    if (isNotFound) {
      const error = new RouteError(404, 'not_found', 'Config file not found. The homeserver may not have started yet.');
      logRouteError({
        requestId,
        route: ROUTE_NAME,
        method: 'GET',
        statusCode: error.status,
        durationMs: Date.now() - startedAt,
        errorType: error.type,
        message: error.message,
      });
      return errorResponse(error, requestId);
    }
    const error = new RouteError(500, 'internal_error', 'Failed to read config file');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(error, requestId);
  }
}

/**
 * POST /api/server-config
 * Body: `{ config_toml: string, checksum: string }`.
 *   - 200 on success with `{ ok, checksum, updated_at, message }`.
 *   - 400 on invalid JSON, invalid TOML, or missing required sections.
 *   - 404 if the config file doesn't exist yet.
 *   - 409 on checksum mismatch, with `current_checksum` in the response so
 *     the UI can show a diff or offer "force save".
 *
 * Redaction roundtrip: if the incoming `config_toml` carries `"********"` for
 * a known sensitive key, the real on-disk value is preserved (never
 * overwritten with the placeholder). See `restoreRedactedValues`.
 *
 * Write is atomic: temp file in the same directory then rename. A crash
 * mid-write leaves the original file intact.
 */
export async function POST(request: NextRequest) {
  const requestId = getRequestId(request);
  const startedAt = Date.now();
  const configPath = getConfigPath();

  let body: { config_toml?: unknown; checksum?: unknown };
  try {
    body = await request.json();
  } catch {
    const error = new RouteError(400, 'bad_request', 'Invalid JSON payload');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: error.message,
    });
    return errorResponse(error, requestId);
  }
  if (typeof body.config_toml !== 'string') {
    return errorResponse(
      new RouteError(400, 'bad_request', 'Missing or invalid config_toml (must be a string)'),
      requestId,
    );
  }
  if (typeof body.checksum !== 'string') {
    return errorResponse(
      new RouteError(400, 'bad_request', 'Missing or invalid checksum (must be a string)'),
      requestId,
    );
  }
  const incomingToml = body.config_toml;
  const incomingChecksum = body.checksum;

  let existing: string;
  try {
    existing = await fs.readFile(configPath, 'utf-8');
  } catch (e) {
    const isNotFound = (e as NodeJS.ErrnoException).code === 'ENOENT';
    if (isNotFound) {
      const error = new RouteError(404, 'not_found', 'Config file does not exist yet');
      logRouteError({
        requestId,
        route: ROUTE_NAME,
        method: 'POST',
        statusCode: error.status,
        durationMs: Date.now() - startedAt,
        errorType: error.type,
        message: error.message,
      });
      return errorResponse(error, requestId);
    }
    const error = new RouteError(500, 'internal_error', 'Failed to read current config');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(error, requestId);
  }

  const currentChecksum = computeChecksum(existing);
  if (incomingChecksum !== currentChecksum) {
    logRouteInfo({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: 409,
      durationMs: Date.now() - startedAt,
      message: 'Checksum mismatch',
    });
    return NextResponse.json(
      {
        error: 'Config has been modified by someone else; reload before saving',
        type: 'conflict',
        current_checksum: currentChecksum,
        requestId,
      },
      { status: 409 },
    );
  }

  const merged = restoreRedactedValues(incomingToml, existing);

  // On managed deployments (Umbrel) the dashboard authenticates to the
  // homeserver with a platform-generated password injected via env. If the
  // user edits admin_password in config.toml the pairing silently breaks:
  // the homeserver starts requiring the new password while the dashboard
  // keeps sending the old one. Reject the edit with an explanation instead.
  // ADMIN_PASSWORD_MANAGED is set by the platform compose, so native
  // deployments (where the operator controls both sides) stay editable.
  if (process.env.ADMIN_PASSWORD_MANAGED === 'true') {
    const extractFirst = (toml: string, key: string): string | null => {
      for (const line of toml.split('\n')) {
        const value = extractStringValue(line.trim(), key);
        if (value !== null) return value;
      }
      return null;
    };
    const incomingPassword = extractFirst(merged, 'admin_password');
    const existingPassword = extractFirst(existing, 'admin_password');
    if (existingPassword !== null && incomingPassword !== existingPassword) {
      const error = new RouteError(
        400,
        'bad_request',
        'admin_password is managed by Umbrel and cannot be changed here. Changing it would disconnect this dashboard from the homeserver. Use the eye icon in Settings to view the current password.',
      );
      logRouteError({
        requestId,
        route: ROUTE_NAME,
        method: 'POST',
        statusCode: error.status,
        durationMs: Date.now() - startedAt,
        errorType: error.type,
        message: 'Rejected admin_password change on managed deployment',
      });
      return errorResponse(error, requestId);
    }
  }

  const validationError = validateTomlStructure(merged);
  if (validationError) {
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: validationError.status,
      durationMs: Date.now() - startedAt,
      errorType: validationError.type,
      message: validationError.message,
    });
    return errorResponse(validationError, requestId);
  }

  const tmpPath = configPath + '.tmp';
  try {
    await fs.writeFile(tmpPath, merged, 'utf-8');
    // Preserve the original file's mode across the rename. The container
    // entrypoint deliberately keeps config.toml at 0660 (it holds
    // admin_password); a default-umask tmp file would widen it to 0644
    // (other-readable) and drop the group write bit on every save.
    const prevStat = await fs.stat(configPath).catch(() => null);
    if (prevStat) await fs.chmod(tmpPath, prevStat.mode & 0o777);
    await fs.rename(tmpPath, configPath);
  } catch (e) {
    try {
      await fs.rm(tmpPath);
    } catch {
      // best effort
    }
    const error = new RouteError(500, 'internal_error', 'Failed to write config');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'POST',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(error, requestId);
  }

  const newChecksum = computeChecksum(merged);
  const stat = await fs.stat(configPath);
  logRouteInfo({
    requestId,
    route: ROUTE_NAME,
    method: 'POST',
    statusCode: 200,
    durationMs: Date.now() - startedAt,
    message: 'Server config updated',
  });
  return NextResponse.json({
    ok: true,
    checksum: newChecksum,
    updated_at: stat.mtime.toISOString(),
    message: `Config saved. Changes take effect after a restart. ${restartAppSentence(getPlatform())}`,
    requestId,
  });
}
