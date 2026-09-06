# Homeserver Dashboard

A small web-based admin dashboard for Pubky homeservers. Built with **Next.js (App Router)**, **React**, and **Tailwind + shadcn/ui**.

The UI lives under a single route: **`/dashboard`** (the home page redirects there).

## Current UI

The dashboard has 6 tabs:

- **Overview**: Shows homeserver stats from `GET /info` including connection status, public key, addresses, version, and user/storage statistics
- **Users**: Disable / enable a user by pubkey via `POST /users/{pubkey}/disable` and `POST /users/{pubkey}/enable`. The disabled-users list is fetched live from the `/users/disabled` admin endpoint.
- **Invites**: Generate signup tokens via `GET /generate_signup_token` with QR code display for easy mobile app signup; view invite statistics (total generated, used, unused)
- **Files**: Full WebDAV file browser (list/read/write/delete/move/create directories) using the `/dav/*` endpoint (Basic Auth). Includes admin "Delete from path" for removing entries by path
- **Logs**: Tails the homeserver's JSON-line log file (level filter, line count). Requires `HOMESERVER_LOG_PATH`; the tab shows as unavailable when it is not set
- **API**: API Explorer for admin/client/metrics endpoints (manual requests)

The navbar **Settings** (gear) button opens **Settings** with two tabs: **Config** (view AND edit the real `config.toml`, with sensitive fields redacted, optimistic-concurrency checks, and atomic writes; falls back to read-only when the file is not writable) and **Cloudflare** (expose the homeserver publicly without port forwarding: a guided **Connect Cloudflare account** flow, an **API token** flow, a manual token/domain form, and a temporary **Preview** tunnel).

## Prerequisites

- Node.js 24+ and npm (matches the `engines` field, CI, and the Docker base image)
- A running Pubky homeserver - every UI section above is wired to live admin endpoints

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Copy `.env.example` to `.env.local` (or create `.env.local` manually):

```bash
cp .env.example .env.local
```

Edit `.env.local` with your homeserver details:

```bash
# Homeserver admin endpoint (server-only variables)
ADMIN_BASE_URL=http://localhost:6288
ADMIN_TOKEN=your-admin-password
```

**Note:** These are server-only environment variables (not prefixed with `NEXT_PUBLIC_*`) to keep sensitive credentials secure. They are only accessible in API routes and server-side code, never exposed to the client browser.

### 3. Run Development Server

```bash
npm run dev
```

Open [http://localhost:8080](http://localhost:8080) in your browser.

### 4. Build for Production

```bash
npm run build
npm start
```

## Docker Deployment

The dashboard can be deployed using Docker, either standalone or as part of an Umbrel app.

### Standalone Docker

Build the Docker image:

```bash
docker build -t homeserver-dashboard .
```

Run the container:

```bash
docker run -d \
  -p 8080:8080 \
  -e PORT=8080 \
  -e ADMIN_BASE_URL=http://homeserver:6288 \
  -e ADMIN_TOKEN=your-admin-password \
  homeserver-dashboard
```

### Umbrel Deployment

The dashboard is included in the `pubky-homeserver` Umbrel app. When deployed via Umbrel:

- The dashboard runs as the `web` service in `docker-compose.yml`
- Environment variables (`ADMIN_BASE_URL`, `ADMIN_TOKEN`) are automatically configured
- The dashboard connects to the homeserver service via Docker networking (`http://homeserver:6288`)
- Access is provided through Umbrel's app proxy (no direct port exposure needed)

The Dockerfile uses Next.js standalone output for optimal image size and includes:

- Multi-stage build for smaller production image
- Non-root user for security
- Proper handling of server-only environment variables

## Configuration

### Environment Variables

All variables are server-only (no `NEXT_PUBLIC_*` prefix) and read lazily at request time.

| Variable                  | Description                                                  | Required | Default                                | What breaks without it                                                             |
| ------------------------- | ------------------------------------------------------------ | -------- | -------------------------------------- | ---------------------------------------------------------------------------------- |
| `ADMIN_BASE_URL`          | Homeserver admin API base URL                                | Yes\*    | -                                      | Admin proxy, invites, users, file browser all fail                                 |
| `ADMIN_TOKEN`             | Admin password/token                                         | Yes\*    | -                                      | Same as above, plus the password reveal in Settings                                |
| `CLIENT_BASE_URL`         | Homeserver client API base URL                               | No       | `http://homeserver:6286`               | API explorer's client group proxies to the wrong host                              |
| `METRICS_BASE_URL`        | Homeserver metrics base URL                                  | No       | `http://homeserver:6289`               | API explorer's metrics group proxies to the wrong host                             |
| `HOMESERVER_CONFIG_PATH`  | Path to homeserver `config.toml`                             | No       | `/app/homeserver-data/config.toml`     | Settings config editor, Cloudflare disconnect reset, restart-pending detection     |
| `HOMESERVER_LOG_PATH`     | Path to homeserver JSON-line log file                        | No       | unset (logs disabled)                  | `/api/logs` answers 503; the Logs tab shows as unavailable                         |
| `CLOUDFLARE_CONFIG_DIR`   | Cloudflare state dir (token, domain, ...)                    | No       | `/app/cloudflare-config`               | Cloudflare tab reports the feature as unsupported                                  |
| `CLOUDFLARED_BIN`         | cloudflared binary path                                      | No       | `/usr/local/bin/cloudflared`           | Connect (browser-auth) and Preview (quick tunnel) flows cannot spawn cloudflared   |
| `CLOUDFLARED_RUNTIME_DIR` | Config dir path as seen by the runtime cloudflared container | No       | `/etc/cloudflared-config`              | Generated `config.yml` points at the wrong `credentials-file` path                 |
| `PREVIEW_INSTANT_ORIGIN`  | Origin the instant preview tunnel forwards to                | No       | `http://homeserver:6286`               | Preview's instant tunnel forwards to the wrong origin                              |
| `CF_API_BASE`             | Cloudflare API base URL                                      | No       | `https://api.cloudflare.com/client/v4` | Tests/e2e override only; leave unset in production                                 |
| `ADMIN_PASSWORD_MANAGED`  | Set `true` on managed platforms (Umbrel)                     | No       | unset                                  | When unset, `admin_password` stays editable; Umbrel sets it to protect the pairing |
| `PLATFORM`                | `umbrel` on the Umbrel app; unset/anything else = standalone | No       | unset (standalone)                     | See "Standalone vs Umbrel" below                                                   |
| `PORT` / `HOSTNAME`       | Next.js standalone server binding                            | No       | `8080` / `0.0.0.0` (Dockerfile)        | Server binds elsewhere                                                             |

### Standalone vs Umbrel

The same image serves both deployments; `PLATFORM` selects the experience:

- **`PLATFORM=umbrel`** (set by the Umbrel app): shows the Cloudflare setup tab and flows, umbrelOS backup guidance, and "restart the app from Umbrel" copy.
- **unset / standalone**: the Cloudflare _setup_ UI and its `/cloudflare-guide` are hidden, and the Cloudflare setup API routes return `404 not_supported` — the dashboard doesn't run the cloudflared containers a standalone deployment lacks, so the tunnel can't be established here. The read-only status views (public address, reachability, the pkarr "Pubky network" check) stay, so if you front the homeserver with your own reverse proxy or tunnel you can still see whether it's reachable and correctly published. Restart copy and the backup note are generic.

\* Required to use the real homeserver APIs

**Security Note:** These variables are server-only (not prefixed with `NEXT_PUBLIC_*`) to prevent exposing sensitive credentials to the browser. They are automatically loaded from `.env.local` in development and from environment variables in production/Docker.

**Docker Note:** In Docker/Umbrel deployments, use the homeserver service name for `ADMIN_BASE_URL` (e.g., `http://homeserver:6288`) instead of `localhost` to connect via Docker networking.

## Development

### Tech Stack

- **Next.js 16** - React framework with App Router
- **React 19** - UI library
- **TypeScript** - Type safety
- **Tailwind CSS 4** - Styling
- **Shadcn UI** - Component library
- **Lucide React** - Icon library
- **Vitest** - Unit + integration test runner
- **ESLint / Prettier / Knip** - Repo hygiene tooling

### Available Scripts

- `npm run dev` - Start development server
- `npm run build` - Build for production
- `npm start` - Start production server
- `npm run lint` - Run ESLint (`eslint .`)
- `npm run lint:fix` - Fix lint issues (`eslint . --fix`)
- `npm run format` - Format files with Prettier
- `npm run format:check` - Check formatting (CI-friendly)
- `npm run knip` - Check for unused files/deps/exports (see `knip.json`)
- `npm test` - Run Vitest
- `npm run test:watch` - Run Vitest in watch mode
- `npm run test:coverage` - Run Vitest with coverage thresholds (CI gate)
- `npm run e2e` - Run the end-to-end suite (`scripts/e2e/`); builds and boots the real server

## Contributing

This project is maintained by the Pubky team at Synonym. Contributions are welcome via pull request. Please ensure:

- Code follows the existing patterns
- Components use Shadcn UI primitives
- TypeScript types are properly defined
- Error handling is comprehensive
- CI gates (`lint`, `typecheck`, `format:check`, `knip`, `test:coverage`, `build`, `docker`) pass before requesting review

## Related Projects

- [pubky-homeserver](https://github.com/pubky/pubky-homeserver) - The homeserver this dashboard manages
- [franky](https://github.com/pubky/franky) - Reference UI implementation (design system source)
