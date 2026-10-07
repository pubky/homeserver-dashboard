/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone', // Enable standalone output for Docker optimization
  // Loaded natively by Node at runtime instead of being bundled: the package
  // is CJS + a .wasm file read with __dirname-relative fs, which every
  // bundler mangles. Its files reach the standalone output via file tracing.
  serverExternalPackages: ['@synonymdev/pkarr'],
  // The dashboard serves its few SVGs as plain files, so the image optimizer
  // is off. Next still traces the optimizer's native binaries (sharp) into the
  // standalone output, where they would be the only architecture-specific
  // code; with the optimizer off nothing loads them, so they are left out.
  images: { unoptimized: true },
  outputFileTracingExcludes: { '*': ['node_modules/sharp/**', 'node_modules/@img/**'] },
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
};

export default nextConfig;
