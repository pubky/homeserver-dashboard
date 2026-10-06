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

## Deployment

There is one build output, the **bundle**. `npm run bundle` runs `next build` and then finishes `.next/standalone`, so that `node server.js` inside that directory is the whole application ([`scripts/bundle.mjs`](scripts/bundle.mjs) has the details). Every deployment is a thin wrapper around the bundle:

|                         | Umbrel                        | Docker (without Umbrel)                    | systemd                                                                      |
| ----------------------- | ----------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- |
| Wrapper                 | the Docker image              | the Docker image                           | [`deploy/homeserver-dashboard.service`](deploy/homeserver-dashboard.service) |
| Settings come from      | the Umbrel app's compose file | `docker run -e ...`                        | the unit and the homeserver's `config.toml`                                  |
| Who authenticates       | Umbrel's app proxy            | admin sign-in, once `ADMIN_PUBKEYS` is set | admin sign-in (`ADMIN_PUBKEYS` in the unit)                                  |
| UI variant (`PLATFORM`) | `umbrel`                      | standalone                                 | standalone                                                                   |
| `config.toml` editor    | on                            | on when the data directory is mounted      | off unless the unit is changed                                               |

**Access control.** The dashboard is an admin tool: whoever gets in can manage users and files and reveal the admin password. It is kept to admins in one of two ways:

- **Something in front of it authenticates.** Umbrel's app proxy does, so the Umbrel app needs nothing more.
- **Admin sign-in with Pubky Ring.** Set `ADMIN_PUBKEYS`, and every API route refuses requests that do not come from a signed-in admin. See [Admin sign-in](#admin-sign-in).

With neither, the dashboard has no login at all, and whoever can reach its port is an admin. Then keep the port on loopback and reach it through an SSH tunnel (`ssh -L 8080:127.0.0.1:8080 <host>`, then open `http://localhost:8080`). Do not publish the port. Loopback narrows who can reach the port; it is not a login. Any user or process on the host can still reach it, and without sign-in a web page in the same browser could reach it through DNS rebinding while a tunnel is open.

### Umbrel

The dashboard is included in the `pubky-homeserver` Umbrel app:

- It runs as the `web` service in the app's `docker-compose.yml`
- Environment variables (`ADMIN_BASE_URL`, `ADMIN_TOKEN`, `PLATFORM=umbrel`) are configured by the app
- It connects to the homeserver service via Docker networking (`http://homeserver:6288`)
- Access is provided through Umbrel's app proxy (no direct port exposure needed)

### Docker (without Umbrel)

Build the image and run it, published on loopback only:

```bash
docker build -t homeserver-dashboard .
docker run -d \
  -p 127.0.0.1:8080:8080 \
  -e ADMIN_BASE_URL=http://homeserver:6288 \
  -e ADMIN_TOKEN=your-admin-password \
  -e ADMIN_PUBKEYS=your-pubky \
  homeserver-dashboard
```

### systemd

For a homeserver that runs as a plain systemd service, the dashboard can run next to it the same way. It needs Node.js 24+ on the host and nothing else.

Build the bundle and install it (the bundle can also be built on another machine with the same OS and CPU architecture and copied over):

```bash
npm ci
npm run bundle
# Copy first and swap after
sudo rm -rf /opt/homeserver-dashboard.new
sudo cp -r .next/standalone /opt/homeserver-dashboard.new
sudo rm -rf /opt/homeserver-dashboard && sudo mv /opt/homeserver-dashboard.new /opt/homeserver-dashboard
```

Install the example unit, and put your pubky (Pubky Ring shows it) in its `ADMIN_PUBKEYS` line:

```bash
sudo cp deploy/homeserver-dashboard.service /etc/systemd/system/
sudoedit /etc/systemd/system/homeserver-dashboard.service     # Environment=ADMIN_PUBKEYS=<your pubky>
sudo systemctl daemon-reload
sudo systemctl enable --now homeserver-dashboard
```

The unit ships with that line empty, which keeps the dashboard closed to everyone until a pubky is filled in.

There is no admin password to set. The unit leaves `ADMIN_TOKEN` unset, and the dashboard then reads `[admin] admin_password` from the homeserver's `config.toml`, the file the homeserver itself takes it from. The password stays in that one place.

To upgrade, repeat the first block and run `sudo systemctl restart homeserver-dashboard`.

The unit is an example: read it before installing. It states what it assumes about the host, and explains each setting, including how to turn on the `config.toml` editor and the Logs tab.

Nothing in the bundle is specific to systemd: any process manager can run `node server.js` with the same environment. Whichever you use, set `HOSTNAME=127.0.0.1`, or the server listens on every interface.

## Configuration

### Environment Variables

All variables are server-only (no `NEXT_PUBLIC_*` prefix) and read lazily at request time.

| Variable                  | Description                                                                   | Required | Default                                | What breaks without it                                                                                                         |
| ------------------------- | ----------------------------------------------------------------------------- | -------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ADMIN_BASE_URL`          | Homeserver admin API base URL                                                 | Yes\*    | -                                      | Admin proxy, invites, users, file browser all fail                                                                             |
| `ADMIN_TOKEN`             | Admin password. Unset: `admin_password` from `HOMESERVER_CONFIG_PATH` is used | No\*     | read from `config.toml`                | With neither: same as above, plus the password reveal in Settings                                                              |
| `CLIENT_BASE_URL`         | Homeserver client API base URL                                                | No       | `http://homeserver:6286`               | API explorer's client group proxies to the wrong host                                                                          |
| `METRICS_BASE_URL`        | Homeserver metrics base URL                                                   | No       | `http://homeserver:6289`               | API explorer's metrics group proxies to the wrong host                                                                         |
| `HOMESERVER_CONFIG_PATH`  | Path to homeserver `config.toml`                                              | No       | `/app/homeserver-data/config.toml`     | Settings config editor, Cloudflare disconnect reset, restart-pending detection, the admin password when `ADMIN_TOKEN` is unset |
| `HOMESERVER_LOG_PATH`     | Path to homeserver JSON-line log file                                         | No       | unset (logs disabled)                  | `/api/logs` answers 503; the Logs tab shows as unavailable                                                                     |
| `CLOUDFLARE_CONFIG_DIR`   | Cloudflare state dir (token, domain, ...)                                     | No       | `/app/cloudflare-config`               | Cloudflare tab reports the feature as unsupported                                                                              |
| `CLOUDFLARED_BIN`         | cloudflared binary path                                                       | No       | `/usr/local/bin/cloudflared`           | Connect (browser-auth) and Preview (quick tunnel) flows cannot spawn cloudflared                                               |
| `CLOUDFLARED_RUNTIME_DIR` | Config dir path as seen by the runtime cloudflared container                  | No       | `/etc/cloudflared-config`              | Generated `config.yml` points at the wrong `credentials-file` path                                                             |
| `PREVIEW_INSTANT_ORIGIN`  | Origin the instant preview tunnel forwards to                                 | No       | `http://homeserver:6286`               | Preview's instant tunnel forwards to the wrong origin                                                                          |
| `CF_API_BASE`             | Cloudflare API base URL                                                       | No       | `https://api.cloudflare.com/client/v4` | Tests/e2e override only; leave unset in production                                                                             |
| `ADMIN_PUBKEYS`           | Pubkys that may sign in with Pubky Ring. Setting it turns admin sign-in on    | No       | unset (no sign-in)                     | See "Admin sign-in" below                                                                                                      |
| `AUTH_RELAY`              | HTTP relay the Ring sign-in goes through                                      | No       | the Pubky SDK's default relay          | Sign-in uses the default relay                                                                                                 |
| `ADMIN_PASSWORD_MANAGED`  | Set `true` on managed platforms (Umbrel)                                      | No       | unset                                  | When unset, `admin_password` stays editable; Umbrel sets it to protect the pairing                                             |
| `PLATFORM`                | `umbrel` on the Umbrel app; unset/anything else = standalone                  | No       | unset (standalone)                     | See "`PLATFORM`: the UI variant" below                                                                                         |
| `PORT` / `HOSTNAME`       | Address and port `server.js` binds                                            | No       | `8080` / `0.0.0.0` (Dockerfile)        | Server binds elsewhere                                                                                                         |

### `PLATFORM`: the UI variant

`PLATFORM` selects the UI variant. It is separate from how the dashboard is deployed: the same bundle serves both variants, and only the Umbrel app sets it.

- **`PLATFORM=umbrel`** (set by the Umbrel app): shows the Cloudflare setup tab and flows, umbrelOS backup guidance, and "restart the app from Umbrel" copy.
- **unset / standalone**: the Cloudflare _setup_ UI and its `/cloudflare-guide` are hidden, and the Cloudflare setup API routes return `404 not_supported` — the dashboard doesn't run the cloudflared containers that only the Umbrel app has, so the tunnel can't be established here. The read-only status views (public address, reachability, the pkarr "Pubky network" check) stay, so if you front the homeserver with your own reverse proxy or tunnel you can still see whether it's reachable and correctly published. Restart copy and the backup note are generic.

### Admin sign-in

`ADMIN_PUBKEYS` turns on a sign-in with [Pubky Ring](https://pubkyring.app/). It is a list of pubkys, comma or space separated, with or without the `pubky` prefix. Only those keys can sign in.

- **What changes.** Every API route except the liveness probe (`/api/health`) and the sign-in routes themselves answers `401` without an admin session. The page shows a QR code; approving it in Ring signs you in. A session lasts at most 8 hours and ends after 30 minutes without activity. Sessions are kept in memory, so restarting the dashboard signs everyone out.
- **The API answers the dashboard page only.** With sign-in on, a request must also carry a header that only the page's own script can add. Opening an API address in the browser, following a link to one, or calling it from another site is refused even with a valid session. A script of your own cannot use the API in this mode either: there is no way to get a session without Ring.
- **Only unset means no sign-in.** A value that is set but empty, or that contains anything that is not a pubky, closes the dashboard completely (`503`) until it is fixed. A typo never opens it.
- **What a sign-in proves.** Ring signs a one-off request that this server issued for this sign-in attempt. The server accepts it only if the signature is valid and recent, the signing key is in `ADMIN_PUBKEYS`, the request is the one it issued, it has not been used before, and it comes from the browser that started the attempt.
- **What it cannot prove.** Ring does not show who is asking. It shows only the request, `/homeserver-dashboard/signin/…`. Whoever shows you a QR code or link for that request gets your admin session when you approve it: a look-alike page, or any other app whose "sign in with Ring" asks for it. Approve that request only when you started the sign-in yourself, on this dashboard, and never when signing in to anything else.
- **The relay.** The signed request travels from Ring to the browser through an HTTP relay: by default the Pubky SDK's, or your own with `AUTH_RELAY`. The relay sees only ciphertext, and what it carries is not enough to sign in. If the relay is unreachable, nobody can sign in.
- **Use HTTPS when the dashboard is reachable from other machines.** The session cookie is `HttpOnly` and `SameSite=Strict`, and is marked `Secure` when the page is served over HTTPS. Over plain HTTP, anyone on the network path can take it. Requests made on behalf of other websites are refused, including other subdomains of the same domain.

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
- `npm run bundle` - Build the bundle every deployment runs (see "Deployment")
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

- [pubky-core](https://github.com/pubky/pubky-core) - The homeserver this dashboard manages
- [franky](https://github.com/pubky/franky) - Reference UI implementation (design system source)
