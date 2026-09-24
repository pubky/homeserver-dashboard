# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.27]

### Added

- An open invite QR now reports signups as they happen. While the QR is on screen the signup-code stats are re-read every few seconds, and a rise in the used count shows a "Someone just joined" confirmation with the counters updated. The homeserver this app ships reports signup-code totals only, with no per-code status, so the panel says a code was used without claiming it was this one, and the QR stays on screen and usable. Watching comes from the admin stats rather than the signup flow, so it also covers someone who joins by typing the homeserver and code into Pubky Ring by hand. An unattended panel stops polling after five minutes.

### Fixed

- The invite QR code and link now carry the `pubkyauth://direct_signup` intent. `pubkyauth://signup` is the relayed cookie flow and expects `caps`, `relay` and `secret`, which an invite has none of: Pubky Ring created the account from the scan and then errored trying to deliver the authorization to a relay that was never in the link. `direct_signup` registers the account on the target homeserver with the invite token and stops there. Needs a Pubky Ring build that understands the intent.

## [0.1.26]

### Fixed

- The published "Public address" is now a working clickable link, and copying it gives a URL that opens. The homeserver reports its address with the publish port (e.g. `sub.trycloudflare.com:443`); pasting that bare `host:443` into a browser failed (the browser tried it over http on 443). The dashboard now drops the default port, infers `https`, and links/copies accordingly (Overview "Public address" and the Settings status address).

### Changed

- The **API** explorer tab is now hidden by default. It's a developer tool, so it only appears when the dashboard is built with `NEXT_PUBLIC_API_EXPLORER=true`; production users no longer see it (or its "Temporary" label).

## [0.1.25]

### Fixed

- A fresh install no longer shows a spurious "restart pending" prompt. The dashboard creates empty Cloudflare `token`/`domain` placeholder files on its first boot (it starts after the config wrapper writes its boot stamp), and the server-side restart-pending probe mistook those just-created files for a real setup change. The placeholders are now backdated to the boot stamp, so the prompt only appears after an actual setup or disconnect.
- The "Sign up from Pubky Ring" step and the invite Pubky-Ring hint now link to [pubkyring.app](https://pubkyring.app/) (the app's site) instead of pubky.org.

## [0.1.24]

### Fixed

- The Cloudflare Status row no longer scrolls sideways when the homeserver is unreachable. A long "Not reachable" reason (e.g. the tunnel-not-connected/restart hint) was rendered inline next to the Check/Disconnect buttons, forcing the dialog to scroll horizontally. The reason now wraps on its own line below the address.
- The Cloudflare Tunnel guide now matches the current Cloudflare dashboard wording: "Add a tunnel" (was "Create a tunnel"), the "Route traffic" step points at the **Published applications** tab, and the connector-state note refers to the "No connectors installed" message you actually see (instead of an "Inactive" state that isn't shown on that page).

## [0.1.23]

### Changed

- **Cloudflare setup failures now explain themselves with full context and deep links.** When provisioning fails, the dashboard names the exact hostname/record, says what went wrong and why, and links straight to the Cloudflare dashboard page where you can fix it:
  - The Connect-account flow's "DNS record already exists" no longer dead-ends with "use the other method" — it names the hostname, explains the clash, and links to your zone's **DNS settings** so you can delete the record (or pick a different subdomain). A leftover-tunnel failure links to the **Zero Trust → Networks → Tunnels** page.
  - The API-token flow's DNS-conflict prompt and its "a locally-managed tunnel already exists" message now carry the same deep links; a permission error lists all three required token permissions at once; and a malformed run token surfaces the specific reason instead of a blank error.
  - A shared error component renders these consistently across the Connect, API-token, and Preview cards.

## [0.1.22]

### Changed

- The "Preview mode" badge on the Overview's public address is now clickable. Instead of a hover-only tooltip, it opens a short dialog that explains in plain terms why a Preview tunnel is temporary (the address can change and briefly drops on restart) and why live updates don't pass through it (the `/events` stream can't connect, so the Pubky network may miss your content). On Umbrel the dialog includes a "Set up Cloudflare account & domain" shortcut straight to the setup flow.

## [0.1.21]

### Added

- **Standalone deployment support.** The dashboard now adapts to where it runs (via a `PLATFORM` env var). Outside Umbrel, the Cloudflare setup flows — which depend on the Umbrel app's tunnel containers and cannot work standalone — are hidden, the Cloudflare setup API routes refuse with a clear error, and the restart/backup copy drops Umbrel-specific wording. The read-only status views (public address, reachability, the Pubky-network/pkarr check) remain, so a standalone operator running their own reverse proxy or tunnel can still see whether their server is reachable and correctly published.
- A "Preview mode" badge on the Overview's public address when it's a temporary `*.trycloudflare.com` Quick Tunnel, with a hover note explaining its limits (brief outages on restart, the `/events` SSE stream doesn't work through it so Pubky indexers may miss content, use a permanent domain for full support).
- The "All set" get-started card can be expanded to review the steps that were verified.

### Fixed

- A rare double-acquire race in the cloudflared setup-flow lock: under concurrent requests a delayed caller could steal a lock another caller had just taken, letting two setup flows run at once. The lock now re-verifies staleness before stealing and restores a live lock it grabbed by mistake.

## [0.1.20]

### Changed

- Every Cloudflare setup tier (API token, manual token paste, and Connect account) now runs as a single locally-managed tunnel. The dashboard converts a tunnel token into the same `credentials.json` + `config.yml` that the Connect flow writes, so the Umbrel app needs only one persistent `cloudflared` container instead of two. A pasted token that is not a real Cloudflare tunnel token is now rejected immediately with a clear message instead of failing silently.

### Added

- A one-time, idempotent boot migration converts older token-mode installs to the locally-managed form on the next start, so existing tunnels keep working seamlessly after the upgrade. (Transitional; scheduled for removal after 2026-12-01.)

### Notes

- This makes everything locally managed: a tunnel whose ingress was configured remotely in the Cloudflare dashboard now uses the dashboard's local ingress (the homeserver origin). This is transparent for the normal single-hostname setup.

## [0.1.19]

### Fixed

- The Overview's "Make your homeserver reachable" step no longer briefly shows "Set up access" while the reachability check is still running. It now shows a "Checking…" spinner until the result is known, then either marks the step done or shows the set-up instruction — so an already-reachable server never flashes a misleading call to action on load. The published-address row likewise shows "Checking…" from the first render instead of momentarily reading "Not set up".

## [0.1.18]

PKARR verification review follow-ups: correctness fix and hardening.

### Fixed

- The Pubky-network row could briefly show one homeserver's record (and its pkdns.net link) under a different homeserver's key if the dashboard switched identity while staying on the page. The verdict and record are now tied to the key they were fetched for and discarded the moment the key changes.

### Changed

- Hardened the relay fetch: it no longer follows redirects, caps the response size, and only accepts http(s) relay URLs. The PKARR package's WebAssembly file is now copied explicitly into the runtime image so the feature cannot silently break in a future build. Added test coverage for the relay classification and signature-verification paths.

## [0.1.17]

PKARR record verification on the Overview.

### Added

- The Overview's new "Pubky network" row verifies the record this homeserver published to the Pubky network (Mainline DHT), not just whether the HTTPS endpoint answers. The dashboard fetches the record from the pkarr relays, checks its ed25519 signature against the homeserver's key, and reconciles the published address and domain against what the homeserver reports it published. It shows Published (verified), Doesn't match config (with a configured-vs-published comparison), Not published, or Can't verify (relays unreachable - which never blames the server).
- A "View" dialog shows the parsed record (each DNS record's type, name, value, and TTL), when it was published, and an independent pkdns.net link. The packet age is shown for information only and never downgrades a matching record: an old-but-correct record is healthy.

### Notes

- Verification is done server-side with the official @synonymdev/pkarr client. The dashboard verifies the relay payload's signature itself rather than trusting the relay, so a misbehaving relay cannot make another key's record appear as this homeserver's.

## [0.1.16]

Preview-mode fix and Overview polish.

### Fixed

- Preview mode failed to enable on a real Umbrel install ("Failed to enable preview mode"). The enable path tried to chmod the preview directory, which the config wrapper owns as uid 65532 while the dashboard runs as uid 1001, so the chmod raised EPERM and the whole flow 500'd. The dashboard no longer touches that directory's permissions (the wrapper owns them); verified by spawning the real embedded cloudflared as uid 1001 inside the container and getting a live tunnel URL.
- The get-started checklist no longer flashes back to "incomplete" for a second when you switch tabs and return. Domain reachability and Cloudflare mode are now cached across the tab unmount and re-validated silently.

### Changed

- "Make your homeserver reachable" copy no longer says "phones": it now explains that Pubky apps and web browsers can reach the server from anywhere, even behind your router, with no port forwarding.
- The Overview links the homeserver pubkey to its pkdns.net record ("Verify on the DHT"), so you can confirm the address, domain, and port published to the Pubky network.

## [0.1.15]

Technical-debt payoff: broken features fixed or removed, honest test gates, tighter permissions.

### Added

- The API explorer's Client and Metrics groups actually work now, via same-origin proxies (they previously fetched Docker-internal hostnames from the browser and could never succeed).
- Published-address scope badge on the Overview: localhost-only, private-network, or public IP, each with a hover explanation of who can reach that address.

### Fixed

- WebDAV rename/copy through the proxy rewrites the Destination header (renames previously targeted a path outside the homeserver's namespace).
- Binary content streams through the admin and WebDAV proxies without UTF-8 corruption.
- Client polling no longer overlaps requests or lets a stale response overwrite newer state; post-setup probe timers stop on unmount.

### Changed

- Coverage gate measures all API/lib/hook/service code instead of a hand-maintained allowlist; thresholds raised to 80/70/80/80; API route suites run under node instead of jsdom; the connect flow parses before sleeping (faster route and tests).
- Env vars are read lazily and every one of them is documented truthfully in README and .env.example; CI builds on the same Node 24 as the image, declared in engines; build context excludes tests/docs/CI files.
- homeserver-data is no longer world-writable: shared group, dirs 2775, config.toml 0660, converged on boot for existing installs.

### Removed

- The unreachable mock ServerControlDialog, dead retry scaffolding in the proxies, vestigial service-constructor plumbing, and the stale status-report doc; `src/libs/` merged into `src/lib/`.

## [0.1.14]

One source of truth in the UI, and a first-run experience that explains itself.

### Added

- The Status section is the single surface asserting Cloudflare state: server-derived mode badge (Connected account / API token / Preview / Off), one reachability chip, a published indicator, and the one Disconnect button with consequences stated before confirming. Setup cards are pure actions that collapse under "Switch setup method" once anything is configured; contradictory states (Status "Off" above a card claiming connected) are impossible by construction.
- Durable "restart pending" signal: the server compares state-file changes against the last boot, so the restart callout survives reloads and disappears only when a restart actually happened. The Overview shows it too.
- "Published" and "reachable" are separate truths: published means the running homeserver actually advertises your address to the Pubky network; reachable means HTTPS answers. The UI no longer suppresses the restart hint just because the tunnel responds.
- Get-started checklist on the Overview (make it reachable, create your first invite, sign up from Pubky Ring), dismissible with a footer link to bring it back, plus a short backup note.
- Invite generation failures are surfaced inline; the invite list is honestly labeled as session-only; Pubky Ring is linked where it is mentioned.

### Changed

- Overview: placeholder pubkey/version replaced by an explicit "Not available" state; auto-recovers while the homeserver starts (poll + Retry) instead of requiring a page reload; copy buttons on identity fields; plain-language labels with the technical terms in tooltips; "Not reachable yet" wording with a restart hint when a restart is known to be pending.
- One canonical restart sentence everywhere, and a consistent user-facing glossary: "public address" vs "domain", "invite code", "public key (pubkey)".
- Friendlier errors: tunnel 530/1033 mapped to "Tunnel not connected", Cloudflare API rate limits explained instead of a generic upstream error; re-running a setup over a live tunnel warns that the address stays down until the restart.
- FileBrowser dialogs gained Cancel buttons; delete-by-path requires an explicit click and shows the resolved target first.
- Logs: download errors surfaced, the download respects the level filter, and a triage caption notes that startup warnings are normal.
- A transient server error no longer hides the entire Cloudflare tab (it shows a retry state instead) or permanently hides the Logs/Users tabs.

## [0.1.13]

Setup-flow correctness: every Cloudflare state transition is now crash-safe, serialized, and cleans up after itself.

### Added

- Cross-flow locks with staleness reaping: setup flows (Connect start/finish, API-token auto-setup, Preview enable) are serialized; an interrupted run can no longer permanently block "Finish setup" with a 409 or silently disable the Connect button. Locks abandoned by a crash are detected (dead pid or over-age) and stolen; disconnect and container start clear them.
- Cert-derived domain: after authorizing, the dashboard reads the authorized zone from the certificate and offers a subdomain-only picker (suggestions: pubky, hs, homeserver) with the domain as a locked suffix, eliminating the wrong-zone hostname failure class. Falls back to the full-hostname input whenever the certificate cannot be parsed; the finish step also rejects out-of-zone hostnames server-side.
- Connect card states its prerequisites up front (free Cloudflare account with your domain added) and points domain-less users at Preview mode.
- E2E suite in `scripts/e2e/` (`npm run e2e`): mock Cloudflare API plus six browser-driven flows (token setup, preview, disconnect, overview health, connect-authorized, preview superseded by real setup). The live release-gate script (`scripts/validate-live-cloudflare.mjs`) now also covers preview enable/disable and disconnect.

### Fixed

- Completing a real setup (Connect or API token) now disables Preview mode: marker removed, temporary tunnel stopped.
- All writes to `token`, `domain`, and `config.yml` are atomic (tmp + rename); crash-looping readers can no longer observe torn files. Mode switches delete the previous mode's files before writing the new mode's, closing the two-tunnels-at-once window.
- Retrying a failed Connect completion reuses the already-created tunnel instead of creating duplicates and orphaning the first one in the user's Cloudflare account; a failed CF-side delete no longer discards the local credentials.
- A failed Preview enable kills the child it spawned and removes the marker (no more "Failed to enable" with the GET reporting enabled).
- Cancel and disconnect remove the scratch authorization certificate, so a cancelled authorization cannot resurrect; the login child is killed by `timeout` after 15 minutes even if nobody polls; over-age certificates are deleted at container start; an expired authorization is announced in the UI instead of silently resetting.
- Stopping Preview escalates SIGTERM to SIGKILL and reports honestly when the process survived.
- Saving a domain without a token in the manual form is rejected with an explanation instead of writing a half-configuration that publishes a dead address.
- Process identity checks record the child's start time, so a recycled pid after a container restart can never kill the wrong process.

### Changed

- Shared `StepList` component for the Connect and auto-setup flows; preview-related internals renamed for clarity (on-disk names unchanged).

## [Unreleased]

Baseline work toward v1.0.0: CI repair, test coverage, security fixes, dead-code cleanup, and dashboard-direct logs + config editing via the shared data-dir bind mount.

### Added

- `GET /api/logs` - JSON-line tail of `HOMESERVER_LOG_PATH`. Reverse-seek tail of the last 4 MB, parses each line as JSON (falls back to `{ raw }` for legacy/plain-text), `?level` filter, `?lines` clamped to [0, 5000], rotation-race tolerance with `partial: true` flag. Returns 503 when `HOMESERVER_LOG_PATH` is unset or the file is missing; the dashboard probes this to decide whether to render the Logs tab.
- `POST /api/server-config` - atomic write (tmp + rename) with optimistic-concurrency `checksum` (409 with `current_checksum` on mismatch), TOML structural validation (required `[general]`, `[drive]`, `[admin]`, `[storage]`), and **redaction roundtrip protection**: the `"********"` placeholder for sensitive keys (`admin_password`, `database_url`) is never written to disk - the real value is preserved when the placeholder comes back from the redacted GET view.
- `GET /api/server-config` extended to return `{ config, checksum, mtime, writable }` so the UI can drive optimistic concurrency, the conflict-recovery flow, the "last modified on disk" footer, and the Edit affordance gating.
- `DashboardLogs` organism re-introduced (real implementation, no mock data) - monospaced viewport, color-coded level badges, level filter, pause / refresh / download-as-`.jsonl` controls, polls every 5s while the tab is mounted.
- `ConfigDialog` upgraded for write mode - Edit/Cancel/Save buttons (gated on `writable`), conflict banner with one-click force-save, success banner pointing the user at Umbrel restart, "last modified on disk" footer.
- `GET /api/health` - dedicated liveness endpoint used by the Dockerfile HEALTHCHECK and any orchestrator probes. Always returns `200 { ok: true }`; does not consult downstream services.
- Vitest coverage for `cloudflare-config`, `server-config` (incl. POST + redaction roundtrip), `public-health`, `admin/generate_signup_token`, `logs`, and `health` route handlers (test count: 12 → 75; file coverage: 5 → 11).
- `smol-toml` promoted from transitive to explicit dependency (used by `/api/server-config` POST for TOML structural validation).
- `LICENSE` (MIT, matching Pubky Homeserver).
- `CHANGELOG.md` following Keep a Changelog.
- `CONTRIBUTORS.md` crediting the original contractor.
- `docs/AUDIT-2026-05-19.md` - forensic audit of the inherited state with the v1.0.0 punch list.
- `.github/dependabot.yml` for npm, github-actions, and docker updates.
- `.github/workflows/codeql.yml` for static analysis.
- CI gates: `knip`, `prettier --check`, and `docker build` in addition to existing lint/typecheck/test/build.
- `HEALTHCHECK` directive in the Dockerfile against `/api/health` on `127.0.0.1`.

### Changed

- README: corrected local dev port (8080, not 3000); removed outdated "no tests currently live" line; updated related-project links to the `pubky` GitHub org; corrected the Users-tab description (disabled users list is live, not mock); now lists 5 tabs (matches the UI); added a forward-looking note about the Logs tab.
- Dockerfile port: unified on `8080` to match `package.json` dev/start scripts (was `3000`).
- Applied a one-time `prettier --write` baseline so `format:check` can be a strict CI gate going forward.

### Removed

- `src/components/organisms/DashboardLogs/` - the orphaned mock Logs tab. The dashboard page no longer has a Logs tab; the component held `generateMockLogs()` placeholder data with no consumer. A real Logs tab will be reintroduced once the homeserver exposes a logs admin endpoint.
- `src/services/user/` and `src/hooks/user/` - scaffold for an earlier user-listing approach that was never wired into the UI (and held seven `console.log` debugging statements).
- `src/components/ui/{dropdown-menu,scroll-area}.tsx` - unused Shadcn primitives.
- `src/components/molecules/Logo/` and `src/components/organisms/InvitesDialog/` - both flagged by `knip` as having zero consumers and held mock placeholder data. New components will be authored against real endpoints in follow-up PRs.
- `withTimeout` (in `src/lib/server/errors.ts`) and `logRouteWarn` (in `src/lib/server/logger.ts`) - unused exports.
- `@radix-ui/react-dropdown-menu` and `@radix-ui/react-scroll-area` from dependencies - only consumed by the deleted UI primitives above.
- `baseline-browser-mapping` from devDependencies - transitive only, no direct consumer.

### Fixed

- Dockerfile `HEALTHCHECK` actually works now. Originally pointed at `/api/public-health` (which requires a `?domain=` param and returns 400 without one) and used `localhost` (which Alpine resolves to `::1` while Next.js binds IPv4 only) - both fixed by adding `/api/health` and using `127.0.0.1`. Verified end-to-end by running the container and observing the `healthy` state transition.
- `public-health` route: use the shared `isAbortError` helper so jsdom `DOMException` instances are correctly mapped to a 504 timeout rather than falling through to a 502.
- `dashboard-ci.yml`: removed the stale `working-directory: homeserver-dashboard` block and corrected `cache-dependency-path` - the repo root is the dashboard, CI never ran correctly before.
- `entrypoint.sh`: tightened Cloudflare config directory permissions from `0777`/`0666` to `0700`/`0600` so the tunnel token is not world-readable on a bind mount.
- Files tab no longer renders a misleading "Request failed: 404 Not Found" with "This directory is empty" stacked underneath when the homeserver is slow or unreachable ([#36]). Three coupled fixes: (a) upstream `fetch` budget raised from 8s to 60s on the WebDAV and admin proxies, since a real PROPFIND against a populated bucket legitimately takes >8s; (b) the proxy retry-on-`AbortError` is disabled (`MAX_RETRIES` 2 → 0) because the same `AbortSignal` was reused across retries so the loop was already a no-op, and retrying a timeout against a slow upstream cannot help anyway; (c) the `WebDavService` client now parses the `{ error, type, requestId }` JSON envelope the proxy already emits, so the dashboard sees a descriptive message and a typed `error.type` instead of `"Request failed: 504 Gateway Timeout"`; (d) `FileBrowser` makes loading / empty / error / file-list branches mutually exclusive, renders type-aware copy ("Couldn't reach the homeserver" for timeout, "Couldn't connect to the homeserver" for `upstream_error`) with an explicit Retry button inside the Alert, and gates the silent `/<pubkey>/pub/` fallback to only fire on non-timeout failures (a slow homeserver isn't going to be faster at the pub path).

[#36]: https://github.com/pubky/homeserver-dashboard/issues/36

### Security

- WebDAV proxy now rejects path segments equal to `.`, `..`, or containing `\0`, `/`, or `\\` - defense-in-depth against path traversal on the homeserver `/dav/` endpoint.
- `cloudflare-config` POST now validates the tunnel token (length 32–2048 chars, URL-safe character class) before persisting; prevents storing junk on paste errors.
