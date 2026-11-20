#!/usr/bin/env node
/**
 * Builds "the bundle": a self-contained copy of the app for running outside
 * Docker (e.g. under systemd). It lives at `.next/standalone`, and
 * `node server.js` inside it is the whole application. The Docker image does
 * not use this script: its Dockerfile assembles the same files itself.
 *
 * Run through `npm run bundle`, which runs `next build` first. `next build`
 * writes most of the directory (server.js, the traced node_modules); what it
 * gets wrong for a self-contained install is fixed here:
 *
 *   + public/, .next/static/       left out by Next, which expects a CDN
 *   + node_modules/@synonymdev/pkarr   copied whole, not left to file tracing
 *   - .env, .env.production        copied in by Next from the checkout
 *
 * It then checks that pkarr's WebAssembly file came along, and fails otherwise.
 * Self-contained (no app imports) and idempotent.
 */
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bundle = path.join(root, '.next', 'standalone');

async function replaceDir(from, to) {
  await fs.rm(to, { recursive: true, force: true });
  await fs.cp(from, to, { recursive: true });
}

try {
  await fs.access(path.join(bundle, 'server.js'));
} catch {
  console.error(
    'No .next/standalone/server.js. Run `npm run build` first (or use `npm run bundle`). If the build ran, a ' +
      'lockfile in a parent directory may have made Next nest the output under .next/standalone/<subdir>/.',
  );
  process.exit(1);
}

await replaceDir(path.join(root, 'public'), path.join(bundle, 'public'));
await replaceDir(path.join(root, '.next', 'static'), path.join(bundle, '.next', 'static'));

// Belt-and-suspenders for the PKARR verification route: @synonymdev/pkarr is a
// CJS+WASM package loaded natively (serverExternalPackages). Next's file
// tracing currently carries pkarr_js_bg.wasm into the bundle, but a future
// Next/nft change could silently drop it - and that would only surface at
// runtime in a deployment (next dev and the unit tests load it from the
// top-level node_modules). Copy it explicitly so the runtime never depends on
// tracing for it.
await replaceDir(
  path.join(root, 'node_modules', '@synonymdev', 'pkarr'),
  path.join(bundle, 'node_modules', '@synonymdev', 'pkarr'),
);

// server.js loads these, so a dev file from the checkout would ship with the
// bundle: readable by whoever can read the install, and filling in every
// variable the host leaves unset. A build in a working checkout has them.
// A deployment's settings come from its wrapper (the unit's Environment= and
// EnvironmentFile=), never from the bundle.
for (const envFile of ['.env', '.env.production']) {
  await fs.rm(path.join(bundle, envFile), { force: true });
}

// The one thing the steps above do not guarantee: that the copied package
// still carries its WebAssembly file. Checked here so that a change in how it
// is published fails the build instead of a deployment.
const pkarrFiles = await fs.readdir(path.join(bundle, 'node_modules', '@synonymdev', 'pkarr'), { recursive: true });
if (!pkarrFiles.some((file) => file.endsWith('.wasm'))) {
  console.error('The bundle is incomplete: @synonymdev/pkarr has no .wasm file');
  process.exit(1);
}

console.log(`Bundle ready: ${path.relative(process.cwd(), bundle) || '.'}`);
