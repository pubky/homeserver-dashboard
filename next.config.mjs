/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The base of the bundle every deployment runs; see scripts/bundle.mjs.
  output: 'standalone',
  // Keeps the bundle's layout fixed. Left to inference, a lockfile in any
  // parent directory makes Next nest it as .next/standalone/<subdir>/server.js.
  outputFileTracingRoot: import.meta.dirname,
  // Loaded natively by Node at runtime instead of being bundled: the package
  // is CJS + a .wasm file read with __dirname-relative fs, which every
  // bundler mangles. Its files reach the bundle via file tracing.
  serverExternalPackages: ['@synonymdev/pkarr'],
};

export default nextConfig;

