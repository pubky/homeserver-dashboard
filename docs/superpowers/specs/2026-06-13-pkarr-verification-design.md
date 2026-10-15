# Pkarr record verification on the Overview

Date: 2026-06-13. Status: approved by user (with leniency + viewer amendments).

## Purpose

The Overview links to pkdns.net so a human can eyeball the PKARR record the
homeserver published to the Pubky network (Mainline DHT, via pkarr relays).
This feature makes the dashboard do that verification itself: fetch the
record, check its ed25519 signature, parse it, and reconcile it against what
the homeserver says it published (`/info`: `public_key`,
`pkarr_pubky_address`, `pkarr_icann_domain`). It catches the failure mode a
plain HTTPS probe cannot: the server is reachable, but the Pubky network is
being told the wrong (or no) address.

## Background facts (verified against sources, 2026-06)

- Pubky Homeserver (`key_republisher.rs`) publishes at startup
  (blocking - boot fails if the publish fails) and republishes **hourly**
  with no retry (failures are logged and skipped until the next tick).
- Its packet contains, all TTL 3600:
  - HTTPS/SVCB at the root, priority 1, target `.`, params
    `port=<public pubky-TLS port>`, `ipv4hint`/`ipv6hint` = public IP;
  - HTTPS/SVCB at the root, priority 10, target = the ICANN domain
    (optionally a `port` param);
  - an A record at the root = public IP.
- Relay protocol (pkarr `design/relays.md`): `GET https://<relay>/<z32 key>`
  returns 64-byte ed25519 signature + 8-byte big-endian timestamp in UNIX
  **microseconds** + DNS wire-format answer packet (max 1000 bytes).
  Signature is BEP44: over `3:seqi{ts}e1:v{len}:{dns-bytes}`.
- Live relays: `https://pkarr.pubky.app`, `https://pkarr.pubky.org`
  (the package defaults), `https://relay.pkarr.org`.
- pkdns.net is a human-facing explorer with no API; it stays a link only.

## Decisions (user-confirmed)

1. **UX shape:** auto badge + detail on demand. A "Pubky network (DHT)" row
   in the Server & Connection card, auto-checked once when the pubkey is
   known, cached across tab switches in `overviewStateCache` (silent
   revalidation - no flash), manual re-check button, and a **"View" record
   viewer** showing the parsed record.
2. **Verdict depth:** full reconciliation (presence, signature, content vs
   `/info`).
3. **Staleness is informational only.** The packet age is shown in the
   viewer, but an old timestamp never downgrades the verdict and never
   instructs the user to do anything, as long as the content matches.
   (Rationale from user: usability; uncertainty about whether the
   homeserver refreshes timestamps - it does republish hourly, but a relay
   may serve an older cached copy, and an old-but-correct record is fine.)
4. **Implementation:** the official `@synonymdev/pkarr` (WASM relay client),
   server-side.
5. **Out of scope:** feeding the get-started checklist or the overall
   health verdict; publishing/CAS; user-key (`_pubky`) records.

## Architecture

### Server: `src/lib/server/pkarr-verify.ts` + `GET /api/pkarr-health`

Route: `GET /api/pkarr-health?pubkey=<z32>&expected_address=<host:port>&expected_domain=<host[:port]>`

- `pubkey` is validated as exactly 52 z-base-32 chars
  (`[ybndrfg8ejkmcpqxot1uwisza345h769]{52}`) before use - it is the only
  value interpolated into relay URLs, so there is no SSRF surface. The
  expected values are comparison-only inputs (never fetched), lightly
  length-capped.
- Resolution: `@synonymdev/pkarr` `Client` with the three relays above,
  ~8 s timeout, `resolveMostRecent()` so one relay's stale cache cannot
  mask a fresher packet. `serverExternalPackages: ['@synonymdev/pkarr']`
  in next.config so the CJS+WASM package is loaded natively by Node.
- If resolution yields nothing, one plain `fetch` to a relay distinguishes
  `not_found` (HTTP 404: genuinely not published/expired) from
  `unavailable` (relays unreachable: explicitly NOT an indictment of the
  server).
- `timestampMs` from the package is microseconds (known bug); converted
  once at the boundary.

The verdict computation is a **pure function** over (parsed records,
timestamp, expected values) so it is unit-testable without the network:

```
verdict: 'verified' | 'mismatch' | 'not_found' | 'invalid' | 'unavailable'
```

- `invalid`: `packet.isValid()` is false (should never happen - relays
  verify on PUT).
- Comparison gates (each independently `match | mismatch | not_compared`):
  - `address`: HTTPS priority-1 record's `port` + `ipv4hint` (or the A
    record's IP) vs `expected_address`;
  - `domain`: HTTPS priority-10 target vs `expected_domain`'s host.
- A gate whose expected value is absent (`/info` did not provide it) or
  whose record is absent from the packet reports `not_compared` and does
  not produce a mismatch verdict on its own; `mismatch` requires at least
  one positive contradiction.
- Response carries the verdict, per-gate results, packet age (ms), the
  parsed record summary (name, type, human-readable value, TTL per record)
  for the viewer, and which relay(s) answered.

Response shape:

```json
{
  "verdict": "verified",
  "gates": { "address": "match", "domain": "match" },
  "published": { "address": "1.2.3.4:6287", "domain": "pubky.example.com" },
  "expected": { "address": "1.2.3.4:6287", "domain": "pubky.example.com" },
  "packet_age_ms": 123456,
  "timestamp_ms": 1765432100000,
  "records": [{ "name": ".", "type": "HTTPS", "value": "1 . port=6287 ipv4hint=1.2.3.4", "ttl": 3600 }],
  "requestId": "..."
}
```

Errors follow the existing RouteError/errorResponse pattern; `unavailable`
and `not_found` are 200s with a verdict (they are check outcomes, not
transport failures).

### Client: Overview row + viewer

- New row "Pubky network (DHT):" under the public-address row in the
  Server & Connection card, chip pattern copied from domain health:
  - `checking` (spinner) / `Published ✓` (verified) / `Mismatch`
    (destructive, names the wrong field in the viewer) / `Not published`
    (destructive) / `Can't verify` (muted - relays unreachable) /
    `invalid` folded into Mismatch styling with its own copy.
- Auto-check once when `public_key` + expectations are known; result cached
  in `overviewStateCache` keyed by pubkey+expectations; on tab return,
  silent revalidate (same pattern as the domain-health fix).
- Manual re-check button (same affordance as the domain Check button).
- **"View" opens the record viewer**: a small dialog (existing Dialog
  component) listing the parsed records (type, name, value, TTL), the
  packet timestamp as relative age ("published 23 minutes ago" -
  informational tone even when old), the expected-vs-published table when
  there is a mismatch, and the pkdns.net "Verify on the DHT" link as the
  independent second opinion (relocated into the viewer footer; the
  existing inline link under the pubkey stays).

## Error handling

- Relay timeouts bounded (~8 s total), AbortController on the fallback
  fetch; the route never throws raw - always RouteError or a verdict.
- The route logs via logRouteInfo/logRouteError like the other probes.
- Client treats route 4xx/5xx as `unavailable` styling with retry.

## Testing

- **Unit (verdict logic):** real signed packets built with the package's
  `Keypair` + `SignedPacket.builder()` fixtures - match, address mismatch,
  domain mismatch, missing gates, no records. No network.
- **Route tests:** relay client wrapped behind a thin module boundary and
  mocked; assert validation (bad pubkey 400), verdict pass-through,
  not_found vs unavailable discrimination.
- **Component tests:** chip states + viewer rendering from fixture
  responses.
- **E2E:** a mock relay server in the harness (next to the mock CF server)
  serving a packet signed with a fixture keypair; spec walks
  checking → verified, plus not_found and unavailable (relay down). The
  homeserver-info mock provides matching/mismatching expectations.
- **Docker reality check:** build the production image, confirm the .wasm
  ships in the standalone trace and the route works in the real container
  as uid 1001 against live relays (the preview-EPERM lesson).

## Release

After merge to main: dashboard v0.1.17 (CHANGELOG + package.json + image
build/push), then umbrel-app-store `release.sh 0.9.1-9
--dashboard-image synonymsoft/homeserver-dashboard:v0.1.17 --notes-file ...
--push`.
