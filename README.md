# Homeserver Dashboard

A small web-based admin dashboard for Pubky homeservers. Built with **Next.js (App Router)**, **React**, and **Tailwind + shadcn/ui**.

The UI lives under a single route: **`/dashboard`** (the home page redirects there).

## Run it next to a homeserver

The dashboard runs beside a Pubky homeserver, on the same machine, and talks to the homeserver's admin API. It needs read access to the homeserver's `config.toml` and nothing else installed: the release archive carries its own Node.js. Nothing here is specific to Docker or Umbrel.

1. **Download the dashboard.** Pick a version from the [releases page](https://github.com/pubky/homeserver-dashboard/releases). Releases are built for Linux on x86-64 (`linux-amd64`) only for now; on anything else, see "from source" below.

   ```bash
   DASHBOARD_VERSION=<version>     # e.g. 0.1.34
   curl -LO https://github.com/pubky/homeserver-dashboard/releases/download/v${DASHBOARD_VERSION}/homeserver-dashboard-v${DASHBOARD_VERSION}-linux-amd64.tar.gz
   tar -xzf homeserver-dashboard-v${DASHBOARD_VERSION}-linux-amd64.tar.gz
   cd homeserver-dashboard-v${DASHBOARD_VERSION}-linux-amd64
   ```

2. **Run it**, pointing it at the homeserver's config and choosing a password for the dashboard's own login.

   ```bash
   HOMESERVER_CONFIG_PATH="$HOME/.pubky/config.toml" \
   DASHBOARD_PASSWORD='a-password-for-the-dashboard' \
   ./homeserver-dashboard
   ```

   Open [http://localhost:8080](http://localhost:8080) and log in.

The dashboard reads the admin API's address and password from that `config.toml` (`[admin]` `listen_socket` and `admin_password`), so they live in one place and a changed password is picked up without restarting the dashboard. The homeserver itself reads its config only when it starts: after changing either setting, restart the homeserver, and expect the dashboard's admin calls to fail until you have. `ADMIN_BASE_URL` and `ADMIN_TOKEN` override what the file says; see [Configuration](#configuration).

Things to know:

- **Give the homeserver an admin password of its own.** A fresh homeserver has `admin_password` commented out in its `config.toml` and accepts the well-known default, `admin`. The dashboard then uses that default too, so it works straight away, and logs a warning. Set your own under `[admin]` and restart the homeserver; the dashboard picks it up from the file.
- **It listens on `127.0.0.1:8080` unless told otherwise.** `DASHBOARD_HOST` and `DASHBOARD_PORT` change that.
- **Without `DASHBOARD_PASSWORD` there is no login.** Whoever can reach the port is then an admin and can reveal the homeserver's admin password.
- **A password typed into a command ends up in your shell's history.** Fine for a try-out; for anything longer-lived keep it in a file only you or root can read, and have whatever starts the dashboard load it from there.
- **Whoever runs it needs to read `config.toml`, and should not be able to read the homeserver's key.** Running it as its own user in the homeserver's group does that.
- **Keeping it running is up to you.** The release is a program to run, not a service: use whatever you run other services with (systemd, a container, a process manager), giving it the same environment as the command above.
- **On another platform, or from source,** build the same thing yourself with Node.js 24+: `npm ci && npm run bundle`, then `node server.js` inside `.next/standalone` ([`scripts/bundle.mjs`](scripts/bundle.mjs) has the details).

### Ways to reach it

| How                                                                                            | Who can reach the dashboard           | What it needs                                                   | Caveats                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Loopback and an SSH tunnel (`ssh -L 8080:127.0.0.1:8080 <host>`, then `http://localhost:8080`) | People with SSH access to the machine | The default address                                             | Other users and processes on the machine can reach a loopback port too, so set `DASHBOARD_PASSWORD` all the same                                                                           |
| A private network (LAN, WireGuard, Tailscale)                                                  | Everyone on that network              | `DASHBOARD_HOST=<the private address>` and `DASHBOARD_PASSWORD` | Over plain HTTP the password and the session cookie cross the network in clear text. Fine on a network that encrypts (WireGuard, Tailscale); on a shared LAN put TLS in front              |
| Public, behind a reverse proxy that terminates TLS (Caddy, nginx, a Cloudflare Tunnel)         | The internet                          | The default address, `DASHBOARD_PASSWORD`, and the proxy        | The login has no rate limiting or lockout. Add a second gate in the proxy (HTTP basic auth, an IP allowlist, an identity-aware proxy) rather than relying on the password alone            |
| The dashboard on a different machine from the homeserver                                       | -                                     | -                                                               | Not recommended. The admin API is plain HTTP with the password in a header, so it would have to cross the network; and Settings and Logs read the homeserver's files, so they stop working |

## Current UI

The dashboard has 6 tabs:

- **Overview**: Shows homeserver stats from `GET /info` including connection status, public key, addresses, version, and user/storage statistics
- **Users**: Look an account up by pubky to change its allowance (storage, download and upload rates and bursts, writable paths) via `GET|PATCH /users/{pubkey}/quota`, and to disable or enable it via `POST /users/{pubkey}/disable` and `POST /users/{pubkey}/enable`. On homeserver 0.17+, the tab also lists every account from the admin `GET /users`: when it signed up, what it stores against its allowance and whether it is disabled, filtered by state and ordered by signup or storage, ten at a time. "Manage" opens a listed account in the editor, which then shows its status and usage from `GET /users/{pubkey}`. On older homeservers the editor's status reads "Not known" until an action here sets it.
- **Invites**: Create invite codes via `GET /generate_signup_token`, or with limits of their own (storage, rates, bursts, writable paths) via `POST /generate_signup_token`. A new code is shown once with a QR code for easy mobile app signup. View invite statistics (total generated, used, unused). On a homeserver that lists its codes (admin `GET /signup_tokens`), see every code it has issued: unused ones with a copy-code action, used ones showing when and by which pubky. Homeserver 0.17+ also reports each code's limits
- **Files**: Full WebDAV file browser (list/read/write/delete/move/create directories) using the `/dav/*` endpoint (Basic Auth). Includes admin "Delete from path" for removing entries by path
- **Logs**: Tails the homeserver's JSON-line log file (level filter, line count). Requires `HOMESERVER_LOG_PATH`; the tab shows as unavailable when it is not set
- **API**: API Explorer for admin/client/metrics endpoints (manual requests)

The navbar **Settings** (gear) button opens **Settings** with two tabs: **Config** (view AND edit the real `config.toml`, with sensitive fields redacted, optimistic-concurrency checks, and atomic writes; falls back to read-only when the file is not writable) and **Cloudflare** (expose the homeserver publicly without port forwarding: a guided **Connect Cloudflare account** flow, an **API token** flow, a manual token/domain form, and a temporary **Preview** tunnel).

## Docker

The dashboard is also published as an image, `synonymsoft/homeserver-dashboard`, which is what the Umbrel app runs.

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
  -e DASHBOARD_PASSWORD=a-password-for-the-dashboard \
  homeserver-dashboard
```

Inside a container the homeserver's `config.toml` is not there to read unless you mount it, and `127.0.0.1` is the container itself, so pass `ADMIN_BASE_URL` and `ADMIN_TOKEN` explicitly as above. Do not mount the homeserver's data directory at `/app/homeserver-data` outside Umbrel: the image's entrypoint changes that directory's group and mode for the Umbrel app's containers.

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

| Variable                            | Description                                                                                                                                        | Required | Default                                       | What breaks without it                                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_BASE_URL`                    | Homeserver admin API base URL                                                                                                                      | No\*     | `[admin]` `listen_socket` from `config.toml`  | Admin proxy, invites, users, file browser all fail                                                                                                              |
| `ADMIN_TOKEN`                       | Admin password/token                                                                                                                               | No\*     | `[admin]` `admin_password` from `config.toml` | Same as above, plus the password reveal in Settings                                                                                                             |
| `CLIENT_BASE_URL`                   | Homeserver client API base URL                                                                                                                     | No       | `http://homeserver:6286`                      | API explorer's client group proxies to the wrong host                                                                                                           |
| `METRICS_BASE_URL`                  | Homeserver metrics base URL                                                                                                                        | No       | `http://homeserver:6289`                      | API explorer's metrics group proxies to the wrong host                                                                                                          |
| `HOMESERVER_CONFIG_PATH`            | Path to homeserver `config.toml`                                                                                                                   | No       | `/app/homeserver-data/config.toml`            | Settings config editor, Cloudflare disconnect reset, restart-pending detection, and the admin API's address and password when the two variables above are unset |
| `HOMESERVER_LOG_PATH`               | Path to homeserver JSON-line log file                                                                                                              | No       | unset (logs disabled)                         | `/api/logs` answers 503; the Logs tab shows as unavailable                                                                                                      |
| `CLOUDFLARE_CONFIG_DIR`             | Cloudflare state dir (token, domain, ...)                                                                                                          | No       | `/app/cloudflare-config`                      | Cloudflare tab reports the feature as unsupported                                                                                                               |
| `CLOUDFLARED_BIN`                   | cloudflared binary path                                                                                                                            | No       | `/usr/local/bin/cloudflared`                  | Connect (browser-auth) and Preview (quick tunnel) flows cannot spawn cloudflared                                                                                |
| `CLOUDFLARED_RUNTIME_DIR`           | Config dir path as seen by the runtime cloudflared container                                                                                       | No       | `/etc/cloudflared-config`                     | Generated `config.yml` points at the wrong `credentials-file` path                                                                                              |
| `PREVIEW_INSTANT_ORIGIN`            | Origin the instant preview tunnel forwards to                                                                                                      | No       | `http://homeserver:6286`                      | Preview's instant tunnel forwards to the wrong origin                                                                                                           |
| `CF_API_BASE`                       | Cloudflare API base URL                                                                                                                            | No       | `https://api.cloudflare.com/client/v4`        | Tests/e2e override only; leave unset in production                                                                                                              |
| `ADMIN_PASSWORD_MANAGED`            | Set `true` on managed platforms (Umbrel)                                                                                                           | No       | unset                                         | When unset, `admin_password` stays editable; Umbrel sets it to protect the pairing                                                                              |
| `PLATFORM`                          | `umbrel` on the Umbrel app; unset/anything else = standalone                                                                                       | No       | unset (standalone)                            | See "Standalone vs Umbrel" below                                                                                                                                |
| `DASHBOARD_PASSWORD`                | Password for the dashboard login                                                                                                                   | No       | unset (no login)                              | No login: anyone who can reach the port gets the full dashboard. The Umbrel app sets it, see below                                                              |
| `PORT` / `HOSTNAME`                 | Next.js standalone server binding                                                                                                                  | No       | `8080` / `0.0.0.0` (Dockerfile)               | Server binds elsewhere                                                                                                                                          |
| `DASHBOARD_HOST` / `DASHBOARD_PORT` | Where the release archive's launcher listens. It uses these instead of `HOSTNAME` / `PORT`, because shells and systems set `HOSTNAME` on their own | No       | `127.0.0.1` / `8080`                          | The dashboard is reachable only from the machine itself                                                                                                         |

### Standalone vs Umbrel

The same image serves both deployments; `PLATFORM` selects the experience:

- **`PLATFORM=umbrel`** (set by the Umbrel app): shows the Cloudflare setup tab and flows, umbrelOS backup guidance, and "restart the app from Umbrel" copy.
- **`DASHBOARD_PASSWORD`** (set by the Umbrel app to the password Umbrel generates for it): every page and API route except `/api/health` needs a login. The Umbrel login only covers browsers; other apps' containers share the Docker network and could reach the dashboard port directly. A standalone deployment should set it too, unless something in front of the dashboard already authenticates; see [Ways to reach it](#ways-to-reach-it).
- **unset / standalone**: the Cloudflare _setup_ UI and its `/cloudflare-guide` are hidden, and the Cloudflare setup API routes return `404 not_supported` — the dashboard doesn't run the cloudflared containers a standalone deployment lacks, so the tunnel can't be established here. The read-only status views (public address, reachability, the pkarr "Pubky network" check) stay, so if you front the homeserver with your own reverse proxy or tunnel you can still see whether it's reachable and correctly published. Restart copy and the backup note are generic.

\* The dashboard needs both to use the homeserver's APIs. When one is unset it is read from the homeserver's `config.toml` at `HOMESERVER_CONFIG_PATH`: the address from `[admin]` `listen_socket` (the homeserver's default, `127.0.0.1:6288`, when the file does not set it) and the password from `[admin]` `admin_password` (the homeserver's default, `admin`, when the file does not set one, with a warning in the log). A variable that is set always wins.

**Security Note:** These variables are server-only (not prefixed with `NEXT_PUBLIC_*`) to prevent exposing sensitive credentials to the browser. They are automatically loaded from `.env.local` in development and from environment variables in production/Docker.

**Docker Note:** In Docker/Umbrel deployments, use the homeserver service name for `ADMIN_BASE_URL` (e.g., `http://homeserver:6288`) instead of `localhost` to connect via Docker networking.

## Development

### Local development

- Node.js 24+ and npm (matches the `engines` field, CI, and the Docker base image)
- A running Pubky homeserver - every UI section above is wired to live admin endpoints

#### 1. Install dependencies

```bash
npm install
```

#### 2. Configure environment

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

#### 3. Run the development server

```bash
npm run dev
```

Open [http://localhost:8080](http://localhost:8080) in your browser.

#### 4. Build for production

```bash
npm run build
npm start
```

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
- `npm run bundle` - Build, then make `.next/standalone` self-contained so `node server.js` inside it is the whole application
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

- [Pubky Homeserver](https://github.com/pubky/pubky-homeserver) - The homeserver this dashboard manages
- [franky](https://github.com/pubky/franky) - Reference UI implementation (design system source)
