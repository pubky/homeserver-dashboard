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
  // Nothing under /api is ever meant to be displayed as a page. Some of it is
  // relayed from elsewhere (files users uploaded, upstream error pages), so
  // every API response is marked inert: no script, no sniffing, no framing.
  // The proxies set the same headers themselves (src/lib/server/inert-content.ts);
  // this covers every other route, present and future.
  async headers() {
    return [
      {
        source: '/api/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "default-src 'none'; frame-ancestors 'none'; sandbox" },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
  // The Pubky SDK is used in the browser only (the admin sign-in screen). Its
  // Node build replaces the process-wide `fetch` with a cookie-jar wrapper as
  // soon as it is loaded, which would make every request this server proxies
  // share one cookie jar. Leave it out of the server build altogether; the
  // server verifies sign-in tokens itself (src/lib/server/auth/ring-token.ts).
  webpack: (config, { isServer }) => {
    if (isServer) config.resolve.alias['@synonymdev/pubky'] = false;
    return config;
  },
};

export default nextConfig;

