// @vitest-environment node
import { readdirSync } from 'fs';
import path from 'path';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Every API route must sit behind the dashboard login except these. A new
// route that forgets withSession fails here instead of shipping open.
const PUBLIC_ROUTES = new Set(['health/route.ts', 'auth/login/route.ts']);
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH'] as const;

const apiDir = path.resolve('src/app/api');
const routeFiles = readdirSync(apiDir, { recursive: true, encoding: 'utf8' })
  .map((file) => file.split(path.sep).join('/'))
  .filter((file) => file.endsWith('/route.ts') && !PUBLIC_ROUTES.has(file));

type Handler = (request: NextRequest, context: unknown) => Promise<Response>;

describe('session guard', () => {
  beforeAll(() => {
    vi.stubEnv('DASHBOARD_PASSWORD', 'secret');
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('finds the routes', () => {
    expect(routeFiles.length).toBeGreaterThan(10);
  });

  it.each(routeFiles)('%s answers 401 without a session', async (file) => {
    const mod = (await import(`./${file.replace(/\.ts$/, '')}`)) as Record<string, unknown>;
    const handlers = METHODS.filter((method) => typeof mod[method] === 'function');
    expect(handlers.length).toBeGreaterThan(0);
    for (const method of handlers) {
      const request = new NextRequest(`http://localhost:8080/api/${path.dirname(file)}`, { method });
      const response = await (mod[method] as Handler)(request, { params: Promise.resolve({ path: [] }) });
      expect(response.status, `${method} ${file}`).toBe(401);
    }
  });
});
