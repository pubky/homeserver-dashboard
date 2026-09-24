# Build stage
FROM node:26-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci

# Copy source code
COPY . .

# Build the Next.js app
# Server-only environment variables (ADMIN_BASE_URL, ADMIN_TOKEN) are set at runtime via docker-compose
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# Production stage
FROM node:26-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# Install su-exec for dropping privileges after fixing permissions
RUN apk add --no-cache su-exec

# Create non-root user. The extra `homeserver` group mirrors the gid of the
# homeserver wrapper image's user (first system group on alpine, gid 101):
# the shared /app/homeserver-data bind mount is group-shared on that gid so
# the dashboard can edit config.toml without world-writable modes (see
# entrypoint.sh for the full uid/gid/mode matrix). su-exec applies
# supplementary groups, so the running server inherits it.
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs && \
    addgroup -g 101 homeserver && \
    adduser nextjs homeserver

# Copy built application from standalone output
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Belt-and-suspenders for the PKARR verification route: @synonymdev/pkarr is a
# CJS+WASM package loaded natively (serverExternalPackages). Next's file
# tracing currently carries pkarr_js_bg.wasm into .next/standalone, but a
# future Next/nft change could silently drop it - and that would only surface
# at runtime in the container (next dev and the unit tests load it from the
# top-level node_modules, so CI would stay green). Copy it explicitly so the
# runtime never depends on tracing for it.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@synonymdev/pkarr ./node_modules/@synonymdev/pkarr

# Embed cloudflared for the Connect (browser-auth) and Test-drive (quick
# tunnel) setup flows. Pinned by digest, copied from the official image -
# same supply-chain posture as the runtime cloudflared container. Static Go
# binary, runs fine on alpine/musl.
COPY --from=cloudflare/cloudflared:2026.5.2@sha256:12ff5c6992a9863db4da270746af7c244bcaee49353039af8104268a18d6c4f0 /usr/local/bin/cloudflared /usr/local/bin/cloudflared

# Boot-time migration for legacy token-mode installs (run by the entrypoint
# as root before the perm phase). Self-contained ESM, no app imports.
COPY scripts/migrate-cf-token.mjs /app/migrate-cf-token.mjs

# Copy entrypoint script and fix line endings (Windows CRLF -> Unix LF)
COPY entrypoint.sh /tmp/entrypoint.sh
RUN sed -i 's/\r$//' /tmp/entrypoint.sh && \
    mv /tmp/entrypoint.sh /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8080

ENV PORT=8080
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget --quiet --tries=1 --spider "http://127.0.0.1:${PORT}/api/health" || exit 1

# Run as root initially to fix permissions, then drop to nextjs
CMD ["/usr/local/bin/entrypoint.sh"]
