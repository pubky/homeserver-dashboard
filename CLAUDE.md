# homeserver-dashboard

Notes for anyone working in this repo, human or agent: the things that are easy to get wrong and are
not obvious from the code. Setup, configuration and deployment are in the README.

The dashboard is a Next.js admin UI for the Pubky homeserver. Its main deployment is the Umbrel app
([`pubky/umbrel-app-store`](https://github.com/pubky/umbrel-app-store)), where it runs as the `web`
service next to the homeserver and a one-shot config wrapper
([`pubky/homeserver-umbrel-config-wrapper`](https://github.com/pubky/homeserver-umbrel-config-wrapper)).
Those three and the app's two `cloudflared` containers share bind mounts and file ownership, so a
permission change here can break the others.

## Running it

- Dev and the image use port 8080, not 3000.
- `--webpack` is forced on both `dev` and `build`. Next 16 defaults to Turbopack, so a bare `next dev`
  or `next build` uses a different bundler than CI and the image.
- Behavior forks on environment variables. `PLATFORM=umbrel` turns on the whole Cloudflare setup UI
  (without it the setup routes return `404 not_supported`). An unset `HOMESERVER_LOG_PATH` hides the
  Logs tab and makes `/api/logs` return 503. `NEXT_PUBLIC_API_EXPLORER=true` is a build-time flag that
  reveals the API tab.
- Read env at request time, never at module scope. The image is built once and gets its env, such
  as `PLATFORM=umbrel`, only when it runs, so a value read at build time is frozen into the image.
- The dashboard has no login: whoever can reach its port is an admin and can read the admin
  password. Only Umbrel's app proxy authenticates. Outside Umbrel, never bind it beyond loopback or
  suggest exposing it without an authenticating proxy in front.

## Testing

CI gates: `lint`, `typecheck`, `format:check`, `knip`, `test:coverage`, the build, and a Docker build.

- `knip` is a hard gate. One unused export, file or dependency fails CI.
- In `cloudflared-process.test.ts`, `expect(peak).toBe(1)` is a safety assertion, not a flake. It
  caught a real double-acquire in the setup-flow lock. If `peak === 2` comes back, investigate the
  steal path in `acquireFlowLock`; do not weaken the assertion.

### E2E

`npm run e2e` is not the Playwright test runner: `playwright-core` is a devDependency only as a
library for driving the system Chrome. The suite is `node scripts/e2e/run-all.mjs`, a sequential
runner where each spec boots its own `next dev` on a free port, plus a mock Cloudflare API, a fake
`cloudflared` binary and a mock homeserver. `scripts/e2e/README.md` has its requirements.

- Specs must not run in parallel. Filter with `npm run e2e -- <name>`.
- It is not in CI and takes about 4 minutes. Run it by hand before merging anything that touches the
  Cloudflare flows, the Overview status rows or `entrypoint.sh`.

## The image

- Nothing in CI starts the image: the unit tests and e2e use the dev server, and the Docker job only
  builds. After touching the Dockerfile or the build output, run the image and look at it.
- `@synonymdev/pkarr` is a CJS + WASM package that Node loads natively at runtime. The build copies
  it explicitly into the runtime output instead of trusting Next's file tracing. If that copy is
  lost, the pkarr check fails only inside the built image: `next dev` and the unit tests load the
  package from the top-level `node_modules`. To check it, open the Overview's "Pubky network" row.
- `cloudflared` is copied from the official image, pinned by sha256 digest in the Dockerfile. The
  Umbrel app's compose file pins the same version for its tunnel containers; bump them together.
- `entrypoint.sh` starts as root, fixes ownership on the shared mounts and drops to `nextjs`
  (uid 1001). The comment block inside it has the full uid/gid/mode matrix. Its invariant is that it
  must never fail the boot: every step is best-effort.
- Never add an unconditional `touch` to the Cloudflare `token` / `domain` placeholder files.
  `entrypoint.sh` creates them once and backdates them to the wrapper's boot stamp. A current mtime
  makes the restart-pending probe report "restart pending" forever (CHANGELOG 0.1.25).

## Homeserver version

The Umbrel app pins its own homeserver image, which can be several releases behind the latest
homeserver. Before relying on a newer admin endpoint or config key, check the version pinned in the
store's `docker-compose.yml`, and keep the dashboard working against it.

## Release

1. Bump the version by hand in two places: `package.json` and a matching `## [x.y.z]` heading in
   `CHANGELOG.md`.
2. Push a `v*.*.*` tag. That triggers the Docker Hub publish (`synonymsoft/homeserver-dashboard`).
3. Nothing reaches Umbrel users until `pubky/umbrel-app-store` pins the new image by digest and bumps
   its own app version. That repo's README documents its versioning scheme.
