// @vitest-environment node
import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';
import { isAdminGuarded } from '@/lib/server/auth/guard';

/**
 * Every route handler must sit behind the admin guard. This test loads each
 * route file under src/app and fails for any exported handler that was not
 * produced by `withAdminAuth`, so a new route cannot ship open by accident.
 *
 * To make a route public on purpose, list it here with the reason.
 */
const PUBLIC_HANDLERS: Record<string, string> = {
  'api/health/route.ts GET': 'liveness probe for Docker and orchestrators; returns no data',
  'api/auth/challenge/route.ts POST': 'first step of signing in',
  'api/auth/login/route.ts POST': 'signing in',
  'api/auth/session/route.ts GET': 'tells the page whether to show the sign-in',
  'api/auth/session/route.ts DELETE': "signing out; acts only on the caller's own cookie",
};

const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC_DIR = path.resolve(APP_DIR, '..');

const filesUnder = (dir: string) =>
  readdirSync(dir, { recursive: true, encoding: 'utf-8' }).map((file) => file.split(path.sep).join('/'));

// Next treats route.js, route.ts, route.jsx, ... anywhere under app/ as a route handler.
const routeFiles = filesUnder(APP_DIR)
  .filter((file) => /^route\.[cm]?[jt]sx?$/.test(path.basename(file)))
  .sort();

const load = (file: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ path.join(APP_DIR, file));

describe('admin guard coverage', () => {
  it('finds the route handlers, all of them under api/', () => {
    expect(routeFiles.length).toBeGreaterThanOrEqual(20);
    expect(routeFiles).toContain('api/admin/[[...path]]/route.ts');
    expect(routeFiles.filter((file) => !file.startsWith('api/'))).toEqual([]);
  });

  it.each(routeFiles)('%s exports only guarded handlers', async (file) => {
    const routeModule = await load(file);
    const handlers = HTTP_METHODS.filter((method) => method in routeModule);
    expect(handlers.length).toBeGreaterThan(0);
    for (const method of handlers) {
      const listedPublic = `${file} ${method}` in PUBLIC_HANDLERS;
      expect({ handler: `${file} ${method}`, guarded: isAdminGuarded(routeModule[method]) }).toEqual({
        handler: `${file} ${method}`,
        guarded: !listedPublic,
      });
    }
  });

  it('lists no public handler that does not exist', async () => {
    for (const entry of Object.keys(PUBLIC_HANDLERS)) {
      const [file, method] = entry.split(' ');
      expect(routeFiles, entry).toContain(file);
      expect(method in (await load(file)), entry).toBe(true);
    }
  });

  it.each(routeFiles)('%s is never prerendered', async (file) => {
    // A statically rendered GET runs once at build time, where no sign-in is
    // configured, and its output is then served to everyone without the guard.
    const routeModule = await load(file);
    expect([undefined, 'force-dynamic']).toContain(routeModule.dynamic);
    expect([undefined, 0]).toContain(routeModule.revalidate);
    expect(routeModule.generateStaticParams).toBeUndefined();
  });

  it('has no pages-router API, which this test does not scan', () => {
    expect(existsSync(path.join(SRC_DIR, 'pages'))).toBe(false);
    expect(existsSync(path.join(SRC_DIR, '..', 'pages'))).toBe(false);
  });

  it('has no Server Actions, which would be endpoints this test cannot see', () => {
    const sources = filesUnder(SRC_DIR).filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !/\.test\./.test(file));
    const withDirective = sources.filter((file) =>
      /^\s*['"]use server['"]/m.test(readFileSync(path.join(SRC_DIR, file), 'utf-8')),
    );
    expect(withDirective).toEqual([]);
  });
});
