// @vitest-environment node
import path from 'path';
import { pathToFileURL } from 'url';
import { describe, expect, it } from 'vitest';
import { INERT_CONTENT_HEADERS, INERT_DOCUMENT_HEADERS } from './inert-content';

type HeaderRule = { source: string; headers: { key: string; value: string }[] };

// Loaded by path at run time: it is plain JavaScript outside the TypeScript project.
const NEXT_CONFIG = pathToFileURL(path.resolve(__dirname, '../../../next.config.mjs')).href;

describe('inert content headers', () => {
  it('stops script, sniffing, framing and inline display', () => {
    expect(INERT_CONTENT_HEADERS['Content-Security-Policy']).toContain('sandbox');
    expect(INERT_CONTENT_HEADERS['Content-Security-Policy']).toContain("default-src 'none'");
    expect(INERT_CONTENT_HEADERS['Content-Security-Policy']).toContain("frame-ancestors 'none'");
    expect(INERT_CONTENT_HEADERS['X-Content-Type-Options']).toBe('nosniff');
    expect(INERT_CONTENT_HEADERS['Content-Disposition']).toBe('attachment');
  });

  // next.config.mjs cannot import this TypeScript module, so it repeats the
  // values for every other route under /api. They must not drift apart.
  it('are the ones next.config.mjs puts on every /api response', async () => {
    const { default: nextConfig } = (await import(/* @vite-ignore */ NEXT_CONFIG)) as {
      default: { headers: () => Promise<HeaderRule[]> };
    };
    const api = (await nextConfig.headers()).find((rule) => rule.source === '/api/:path*');
    const configured = Object.fromEntries((api?.headers ?? []).map(({ key, value }) => [key, value]));
    expect(configured).toEqual(INERT_DOCUMENT_HEADERS);
  });
});
