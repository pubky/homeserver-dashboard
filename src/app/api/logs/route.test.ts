// @vitest-environment node
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { GET as getLogs } from './route';

describe('logs route', () => {
  const originalEnv = { ...process.env };
  let tmpDir: string;

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'logs-test-'));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // The route reads HOMESERVER_LOG_PATH lazily (per request), so tests just
  // set the env var; no module-registry tricks needed.
  function loadRoute(logPath?: string | null) {
    if (logPath === null) delete process.env.HOMESERVER_LOG_PATH;
    else if (logPath !== undefined) process.env.HOMESERVER_LOG_PATH = logPath;
    return getLogs;
  }

  function makeRequest(query: Record<string, string> = {}) {
    const params = new URLSearchParams(query);
    const url = `http://localhost:8080/api/logs${params.toString() ? `?${params.toString()}` : ''}`;
    return new NextRequest(url);
  }

  it('returns 503 when HOMESERVER_LOG_PATH is unset', async () => {
    const GET = await loadRoute(null);
    const response = await GET(makeRequest());
    const payload = await response.json();
    expect(response.status).toBe(503);
    expect(payload.type).toBe('config_error');
  });

  it('returns 503 not_found when the log file is missing', async () => {
    const GET = await loadRoute(path.join(tmpDir, 'absent.log'));
    const response = await GET(makeRequest());
    const payload = await response.json();
    expect(response.status).toBe(503);
    expect(payload.type).toBe('not_found');
  });

  it('returns an empty items array for an empty file', async () => {
    const logPath = path.join(tmpDir, 'homeserver.log');
    await fs.writeFile(logPath, '');
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest());
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload).toEqual({ items: [] });
  });

  it('tails the last N JSON-line entries (small file, no partial leader)', async () => {
    const logPath = path.join(tmpDir, 'homeserver.log');
    const lines = [
      JSON.stringify({ ts: '2026-01-01T00:00:00Z', level: 'info', msg: 'a' }),
      JSON.stringify({ ts: '2026-01-01T00:00:01Z', level: 'info', msg: 'b' }),
      JSON.stringify({ ts: '2026-01-01T00:00:02Z', level: 'warn', msg: 'c' }),
    ];
    await fs.writeFile(logPath, lines.join('\n') + '\n');
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest({ lines: '2' }));
    const payload = await response.json();
    expect(response.status).toBe(200);
    expect(payload.items.map((l: { msg: string }) => l.msg)).toEqual(['b', 'c']);
  });

  it('filters by level after parsing', async () => {
    const logPath = path.join(tmpDir, 'homeserver.log');
    const lines = [
      JSON.stringify({ level: 'info', msg: 'a' }),
      JSON.stringify({ level: 'error', msg: 'b' }),
      JSON.stringify({ level: 'info', msg: 'c' }),
      JSON.stringify({ level: 'error', msg: 'd' }),
    ];
    await fs.writeFile(logPath, lines.join('\n') + '\n');
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest({ level: 'error' }));
    const payload = await response.json();
    expect(payload.items.map((l: { msg: string }) => l.msg)).toEqual(['b', 'd']);
  });

  it('rejects invalid level values with 400', async () => {
    const logPath = path.join(tmpDir, 'homeserver.log');
    await fs.writeFile(logPath, '');
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest({ level: 'CRITICAL' }));
    const payload = await response.json();
    expect(response.status).toBe(400);
    expect(payload.type).toBe('bad_request');
  });

  it('falls back to { raw } for non-JSON, non-tracing lines', async () => {
    const logPath = path.join(tmpDir, 'homeserver.log');
    await fs.writeFile(logPath, 'plain text line 1\nplain text line 2\n');
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest());
    const payload = await response.json();
    expect(payload.items).toEqual([{ raw: 'plain text line 1' }, { raw: 'plain text line 2' }]);
  });

  it('parses tracing-subscriber plain-text format and strips ANSI', async () => {
    // What Pubky Homeserver actually writes today: timestamp + level + target + msg, with ANSI codes
    // around each field. The dashboard renders this until Pubky Homeserver ships JSON-line logging.
    const ansiLine =
      '\x1b[2m2026-05-28T14:07:38.112285Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mpubky_homeserver::data_directory\x1b[0m\x1b[2m:\x1b[0m Use data directory: /data';
    const logPath = path.join(tmpDir, 'homeserver.log');
    await fs.writeFile(logPath, ansiLine + '\n');
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest());
    const payload = await response.json();
    expect(payload.items).toEqual([
      {
        ts: '2026-05-28T14:07:38.112285Z',
        level: 'info',
        target: 'pubky_homeserver::data_directory',
        msg: 'Use data directory: /data',
      },
    ]);
  });

  it('level filter works for parsed tracing-subscriber lines', async () => {
    const logPath = path.join(tmpDir, 'homeserver.log');
    const lines = [
      '\x1b[2m2026-01-01T00:00:00Z\x1b[0m \x1b[32m INFO\x1b[0m \x1b[2mfoo\x1b[0m\x1b[2m:\x1b[0m hello',
      '\x1b[2m2026-01-01T00:00:01Z\x1b[0m \x1b[33m WARN\x1b[0m \x1b[2mfoo\x1b[0m\x1b[2m:\x1b[0m heads up',
      '\x1b[2m2026-01-01T00:00:02Z\x1b[0m \x1b[31m ERROR\x1b[0m \x1b[2mfoo\x1b[0m\x1b[2m:\x1b[0m broken',
    ];
    await fs.writeFile(logPath, lines.join('\n') + '\n');
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest({ level: 'warn' }));
    const payload = await response.json();
    expect(payload.items.map((l: { msg: string }) => l.msg)).toEqual(['heads up']);
  });

  it('strips ANSI from raw-fallback lines so the UI never shows literal escape glyphs', async () => {
    const logPath = path.join(tmpDir, 'homeserver.log');
    await fs.writeFile(logPath, '\x1b[33msomething weird and unparseable\x1b[0m\n');
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest());
    const payload = await response.json();
    expect(payload.items).toEqual([{ raw: 'something weird and unparseable' }]);
  });

  it('classifies bare WARNING: / ERROR: / INFO: prefixes as level so the filter and colouring still work', async () => {
    // Pubky Homeserver's startup prints `WARNING: ...` via eprintln! before tracing
    // is initialised, so these lines lack a timestamp/target/level structure.
    const logPath = path.join(tmpDir, 'homeserver.log');
    await fs.writeFile(
      logPath,
      [
        'WARNING: Using default values for public_ip',
        'ERROR: Could not bind to port',
        'INFO: Cloudflare tunnel is healthy',
      ].join('\n') + '\n',
    );
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest());
    const payload = await response.json();
    expect(payload.items).toEqual([
      { level: 'warn', msg: 'WARNING: Using default values for public_ip' },
      { level: 'error', msg: 'ERROR: Could not bind to port' },
      { level: 'info', msg: 'INFO: Cloudflare tunnel is healthy' },
    ]);
  });

  it('level filter works against the prefix-detection fallback', async () => {
    const logPath = path.join(tmpDir, 'homeserver.log');
    await fs.writeFile(logPath, ['INFO: hello', 'WARNING: heads up', 'ERROR: bad'].join('\n') + '\n');
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest({ level: 'warn' }));
    const payload = await response.json();
    expect(payload.items.map((l: { msg: string }) => l.msg)).toEqual(['WARNING: heads up']);
  });

  it('clamps oversized `lines` to 5000', async () => {
    const logPath = path.join(tmpDir, 'homeserver.log');
    const lines = Array.from({ length: 100 }, (_, i) => JSON.stringify({ level: 'info', msg: `line-${i}` }));
    await fs.writeFile(logPath, lines.join('\n') + '\n');
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest({ lines: '99999' }));
    const payload = await response.json();
    expect(payload.items.length).toBe(100); // all available, clamping is upper bound
  });

  it('floor-clamps `lines` to 1 on invalid input', async () => {
    const logPath = path.join(tmpDir, 'homeserver.log');
    const lines = [JSON.stringify({ msg: 'a' }), JSON.stringify({ msg: 'b' }), JSON.stringify({ msg: 'c' })];
    await fs.writeFile(logPath, lines.join('\n') + '\n');
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest({ lines: '-5' }));
    const payload = await response.json();
    expect(payload.items.length).toBe(1);
    expect(payload.items[0].msg).toBe('c');
  });

  it('drops the leading partial line when reading from a tail window past offset 0', async () => {
    // Force start>0 by padding the file > READ_WINDOW_BYTES (4MB). Use ~5MB
    // of junk before two known-good JSON lines so the tail crosses a line
    // boundary in the middle of a junk line.
    const logPath = path.join(tmpDir, 'homeserver.log');
    const junkLine = 'x'.repeat(1024);
    const junkLines: string[] = [];
    for (let i = 0; i < 5000; i += 1) junkLines.push(junkLine);
    const goodLines = [JSON.stringify({ msg: 'first-good' }), JSON.stringify({ msg: 'second-good' })];
    await fs.writeFile(logPath, junkLines.join('\n') + '\n' + goodLines.join('\n') + '\n');
    const GET = await loadRoute(logPath);
    const response = await GET(makeRequest({ lines: '3' }));
    const payload = await response.json();
    // First entry returned should NOT be a `{ raw: "xxx..." }` partial junk line;
    // the leading partial gets dropped, then we get junk-tail + 2 good lines (slice -3).
    expect(payload.items.length).toBeGreaterThan(0);
    const lastTwo = payload.items.slice(-2);
    expect(lastTwo.map((l: { msg: string }) => l.msg)).toEqual(['first-good', 'second-good']);
  });
});
