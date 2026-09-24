import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';

// Env is read lazily (call time, not module load), following the convention
// in cloudflared-process.ts, so tests and multi-env deployments are never
// frozen to a stale value.
const getLogPath = () => process.env.HOMESERVER_LOG_PATH || '';
const ROUTE_NAME = '/api/logs';
const DEFAULT_LINES = 500;
const MAX_LINES = 5000;
// Read at most this much of the tail. Each JSON-line is typically <500 bytes,
// so 4MB is ~8k lines - generous enough that MAX_LINES tail requests
// (5k lines) almost always fit. If the file is smaller than this, we read it
// all and `startedAtZero` is true (no partial leading line to discard).
const READ_WINDOW_BYTES = 4 * 1024 * 1024;
const VALID_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error']);

export type LogLine = {
  ts?: string;
  level?: string;
  target?: string;
  msg?: string;
  fields?: Record<string, unknown>;
  /** Present when the line was not valid JSON (legacy/plain-text file). */
  raw?: string;
};

type TailResult = { text: string; startedAtZero: boolean; partial: boolean };

async function tailFile(path: string, maxBytes: number): Promise<TailResult> {
  // Open by path → fd. The fd refers to a specific inode, so a concurrent
  // rotation (rename + new file) leaves us reading from the old inode cleanly.
  // The one case we still defend against: truncation of THIS inode (rare for
  // tracing-appender, but possible if an operator runs `: > homeserver.log`).
  let handle = await fs.open(path, 'r');
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    if (length === 0) return { text: '', startedAtZero: start === 0, partial: false };

    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    if (bytesRead === length) {
      return { text: buffer.toString('utf-8'), startedAtZero: start === 0, partial: false };
    }

    // File shrank between stat and read. Retry once against a freshly opened fd.
    await handle.close();
    handle = await fs.open(path, 'r');
    const stat2 = await handle.stat();
    const start2 = Math.max(0, stat2.size - maxBytes);
    const length2 = stat2.size - start2;
    if (length2 === 0) return { text: '', startedAtZero: true, partial: true };
    const buffer2 = Buffer.alloc(length2);
    const { bytesRead: bytesRead2 } = await handle.read(buffer2, 0, length2, start2);
    const text = buffer2.subarray(0, bytesRead2).toString('utf-8');
    return { text, startedAtZero: start2 === 0, partial: bytesRead2 < length2 };
  } finally {
    await handle.close();
  }
}

// Matches `\x1b[<args><letter>` - CSI sequences from terminal-color output
// (e.g. `\x1b[2m`, `\x1b[0m`, `\x1b[32m`). Pubky Homeserver's tracing subscriber
// emits these around timestamp/level/target when colors are on. Strip before
// parsing or returning, otherwise the UI shows literal `␛[2m...` glyphs.
const ANSI_CSI = /\x1b\[[0-9;]*[A-Za-z]/g;

// Matches the tracing-subscriber default plain-text format after ANSI strip:
//   `<RFC3339 timestamp>  <LEVEL> <target>: <message>`
// Example:
//   `2026-05-28T14:07:38.112285Z  INFO pubky_homeserver: Use data directory: /data`
// `target` must be greedy so it captures the `::` separators that Rust modules
// use (e.g. `pubky_homeserver::data_directory::persistent_data_dir`); the regex
// engine backtracks until the final `:` lands before a space.
const TRACING_LINE =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)\s+(TRACE|DEBUG|INFO|WARN|ERROR)\s+(\S+):\s+(.*)$/;

// Matches a bare level prefix on unstructured stderr (e.g. the `WARNING: ...`
// lines Pubky Homeserver prints from `eprintln!` before its tracing subscriber is
// initialised). Maps "WARNING" to warn so the level filter and colour coding
// still work on those lines.
const LEVEL_PREFIX = /^(TRACE|DEBUG|INFO|WARNING|WARN|ERR(?:OR)?)\s*[:|-]\s*(.*)$/i;
const LEVEL_PREFIX_MAP: Record<string, string> = {
  trace: 'trace',
  debug: 'debug',
  info: 'info',
  warn: 'warn',
  warning: 'warn',
  err: 'error',
  error: 'error',
};

function parseLine(line: string): LogLine {
  // JSON-line path: preferred shape, future-proof for when Pubky Homeserver ships
  // the structured logging change we asked for.
  try {
    const parsed = JSON.parse(line);
    if (parsed && typeof parsed === 'object') return parsed as LogLine;
  } catch {
    // fall through
  }

  // Plain-text path: strip ANSI then try the tracing-subscriber regex.
  const stripped = line.replace(ANSI_CSI, '');
  const tracing = TRACING_LINE.exec(stripped);
  if (tracing) {
    return { ts: tracing[1], level: tracing[2].toLowerCase(), target: tracing[3], msg: tracing[4] };
  }

  // Last-resort prefix match for unstructured stderr like `WARNING: ...`.
  const prefix = LEVEL_PREFIX.exec(stripped);
  if (prefix) {
    return { level: LEVEL_PREFIX_MAP[prefix[1].toLowerCase()], msg: stripped };
  }
  return { raw: stripped };
}

function parseLines(text: string, dropFirst: boolean): LogLine[] {
  const split = text.split('\n').filter((line) => line.length > 0);
  const effective = dropFirst && split.length > 0 ? split.slice(1) : split;
  return effective.map<LogLine>((line) => parseLine(line));
}

/**
 * GET /api/logs
 *
 * Tails `HOMESERVER_LOG_PATH` (the homeserver's rotating JSON-line log file
 * written into the shared data dir). Read-only.
 *
 * Query params:
 *   - `lines` (default 500, clamped to [1, 5000]) - number of trailing lines.
 *   - `level` (optional, one of trace|debug|info|warn|error) - filter.
 *
 * Behaviour:
 *   - 503 if `HOMESERVER_LOG_PATH` is unset (logs are not enabled).
 *   - 503 with `not_found` if the file does not exist yet.
 *   - Lines that are not valid JSON are returned as `{ raw: <line> }`, so an
 *     early/legacy plain-text log file still renders.
 *   - On a rare rotation/truncation race, the response includes `partial: true`.
 */
export async function GET(request: NextRequest) {
  const requestId = getRequestId(request);
  const startedAt = Date.now();

  const logPath = getLogPath();
  if (!logPath) {
    const error = new RouteError(503, 'config_error', 'Logs are not enabled (HOMESERVER_LOG_PATH not set)');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: error.status,
      errorType: error.type,
      message: error.message,
    });
    return errorResponse(error, requestId);
  }

  const linesParam = request.nextUrl.searchParams.get('lines');
  let n = DEFAULT_LINES;
  if (linesParam !== null) {
    const parsed = parseInt(linesParam, 10);
    if (Number.isFinite(parsed)) {
      n = Math.max(1, Math.min(parsed, MAX_LINES));
    }
  }

  const level = request.nextUrl.searchParams.get('level')?.toLowerCase();
  if (level && !VALID_LEVELS.has(level)) {
    const error = new RouteError(400, 'bad_request', `Invalid level: ${level}`);
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: error.status,
      errorType: error.type,
      message: error.message,
    });
    return errorResponse(error, requestId);
  }

  try {
    const { text, partial, startedAtZero } = await tailFile(logPath, READ_WINDOW_BYTES);
    let items = parseLines(text, !startedAtZero);
    if (level) {
      items = items.filter((line) => line.level?.toLowerCase() === level);
    }
    items = items.slice(-n);
    logRouteInfo({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      message: 'Logs tail',
      meta: { count: items.length, partial, level: level ?? null, lines: n },
    });
    return NextResponse.json(partial ? { items, partial: true } : { items });
  } catch (e) {
    const isNotFound = (e as NodeJS.ErrnoException).code === 'ENOENT';
    if (isNotFound) {
      const error = new RouteError(503, 'not_found', 'Log file does not exist yet');
      logRouteError({
        requestId,
        route: ROUTE_NAME,
        method: 'GET',
        statusCode: error.status,
        errorType: error.type,
        message: error.message,
      });
      return errorResponse(error, requestId);
    }
    const error = new RouteError(500, 'internal_error', 'Failed to read log file');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: error.status,
      errorType: error.type,
      message: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(error, requestId);
  }
}
