/**
 * Fetches the homeserver's PKARR record from the pkarr relays and reconciles
 * it against what the homeserver says it published (/info). Catches the
 * failure mode an HTTPS probe cannot: the server is reachable, but the Pubky
 * network is being told the wrong (or no) address.
 *
 * Resolution uses the official @synonymdev/pkarr WASM client (relay
 * transport; loaded natively via serverExternalPackages - bundlers break
 * its CJS+WASM layout). Two of its quirks are handled here and must not
 * leak past this module:
 *  - SignedPacket.timestampMs returns MICROseconds despite the name;
 *  - resolveMostRecent() returns undefined for both "no record exists" and
 *    "no relay reachable", so undefined is classified with a raw fetch
 *    (relays answer 404 for a nonexistent key after a server-side DHT
 *    lookup, ~7s).
 */
import { isIP } from 'net';
import { createPublicKey, verify as ed25519Verify } from 'crypto';
import { Client, SignedPacket } from '@synonymdev/pkarr';
import { Z32_ALPHABET } from '@/lib/pubky';

export type PkarrGate = 'match' | 'mismatch' | 'not_compared';
export type PkarrVerdict = 'verified' | 'mismatch' | 'not_found' | 'invalid' | 'unavailable';

export interface PkarrRecordSummary {
  /** Record owner relative to the pubkey origin: '@' for the root. */
  name: string;
  type: string;
  value: string;
  ttl: number;
}

export interface PkarrExpected {
  /** "ip:port" from /info pkarr_pubky_address (IPv6 arrives unbracketed). */
  address: string | null;
  /** "domain[:port]" from /info pkarr_icann_domain; port is ignored. */
  domain: string | null;
}

/** What the verdict needs from a SignedPacket, extracted so the comparison
 * logic is a pure, network-free function. */
export interface PkarrPacketFacts {
  pubkey: string;
  valid: boolean;
  timestampUs: number;
  records: unknown[];
}

export interface PkarrCheckResult {
  verdict: PkarrVerdict;
  gates: { address: PkarrGate; domain: PkarrGate };
  published: { address: string | null; domain: string | null };
  expected: { address: string | null; domain: string | null };
  timestamp_ms: number | null;
  packet_age_ms: number | null;
  records: PkarrRecordSummary[];
}

/** The wire shape of @synonymdev/pkarr's `packet.records` entries (typed
 * `Array<any>` upstream). Params values arrive as strings ("6287"). */
interface RawRecord {
  name?: string;
  ttl?: number;
  rdata?: {
    type?: string;
    priority?: number;
    target?: string;
    params?: Record<string, unknown>;
    address?: string;
    value?: string;
  };
}

const DEFAULT_RELAYS = ['https://pkarr.pubky.app', 'https://pkarr.pubky.org', 'https://relay.pkarr.org'];
/** Bounds both the WASM client's resolve and the classification fetches. */
const RESOLVE_TIMEOUT_MS = 8000;

/** A relay payload is at most 64 (sig) + 8 (timestamp) + 1000 (DNS) bytes per
 * the pkarr relay spec; a generous cap rejects a buggy/hostile relay trying
 * to stream a large body without affecting any real record. */
const MAX_RELAY_PAYLOAD_BYTES = 2048;

/** Relay list override for tests/e2e (comma-separated). Read lazily per
 * call, like every other env read in this codebase. Only http(s) URLs are
 * accepted, since each entry is used as a fetch base. */
export function getPkarrRelays(): string[] {
  const env = (process.env.PKARR_RELAYS ?? '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => /^https?:\/\//.test(s));
  return env.length > 0 ? env : DEFAULT_RELAYS;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

const stripDot = (s: string) => s.replace(/\.$/, '');
const stripBrackets = (s: string) => s.replace(/^\[|\]$/g, '');

/** Canonicalizes an IP for textual comparison ("0:0:0:0:0:0:0:1" === "::1").
 * The URL parser is the only IPv6 canonicalizer in the stdlib. */
function canonHost(host: string): string {
  const h = stripBrackets(stripDot(host.trim().toLowerCase()));
  if (isIP(h) === 6) {
    try {
      return stripBrackets(new URL(`http://[${h}]`).hostname);
    } catch {
      return h;
    }
  }
  return h;
}

/**
 * Splits /info's "host:port" formats. IPv6 arrives UNBRACKETED ("::1:6287"),
 * so a bare IP is checked first and otherwise the LAST colon splits host
 * from port - never the first.
 */
export function splitHostPort(input: string): { host: string; port: number | null } | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  // Bracketed "[v6]:port" / "[v6]" (never produced by /info, but cheap).
  const bracketed = s.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  if (bracketed) {
    const port = bracketed[2] ? Number(bracketed[2]) : null;
    return { host: canonHost(bracketed[1]), port: port && port >= 1 && port <= 65535 ? port : null };
  }
  if (isIP(s)) return { host: canonHost(s), port: null };
  const i = s.lastIndexOf(':');
  if (i === -1) return { host: canonHost(s), port: null };
  const portStr = s.slice(i + 1);
  const port = /^\d{1,5}$/.test(portStr) ? Number(portStr) : NaN;
  if (!Number.isFinite(port) || port < 1 || port > 65535) return { host: canonHost(s), port: null };
  return { host: canonHost(s.slice(0, i)), port };
}

/**
 * The unbracketed IPv6:port format is genuinely ambiguous: "::1:6287" is
 * itself a valid IPv6 address AND "::1" + port 6287. Every readable
 * interpretation is returned and the address gate matches when ANY of them
 * matches - a published record never gets called wrong because of how a
 * string was split.
 */
export function addressInterpretations(input: string): Array<{ host: string; port: number | null }> {
  const out: Array<{ host: string; port: number | null }> = [];
  const whole = splitHostPort(input);
  if (whole) out.push(whole);
  const s = input.trim().toLowerCase();
  // When the whole string parsed as one bare IPv6, the last-colon split is a
  // second legitimate reading.
  if (isIP(s) === 6) {
    const i = s.lastIndexOf(':');
    const portStr = s.slice(i + 1);
    if (i > 0 && /^\d{1,5}$/.test(portStr)) {
      const port = Number(portStr);
      const host = s.slice(0, i);
      if (port >= 1 && port <= 65535 && isIP(host)) out.push({ host: canonHost(host), port });
    }
  }
  return out;
}

function asRecords(records: unknown[]): RawRecord[] {
  return records.filter((r): r is RawRecord => typeof r === 'object' && r !== null);
}

/** True when the record sits at the pubkey origin (name is the bare pubkey,
 * with or without a trailing dot). */
function isRootRecord(rec: RawRecord, pubkey: string): boolean {
  const name = stripDot((rec.name ?? '').toLowerCase());
  return name === pubkey.toLowerCase() || name === '' || name === '.';
}

interface PublishedFacts {
  /** "host[:port]" the packet advertises for the pubky-TLS endpoint. */
  address: string | null;
  addressHost: string | null;
  addressPort: number | null;
  /** Every host the packet can be said to advertise (ipv4hint, ipv6hint, A,
   * AAAA) - the expected host matching ANY of them counts as a match. */
  addressHostCandidates: string[];
  domain: string | null;
}

function extractPublished(records: RawRecord[], pubkey: string): PublishedFacts {
  const root = records.filter((r) => isRootRecord(r, pubkey));
  const https = root.filter((r) => r.rdata?.type === 'HTTPS' || r.rdata?.type === 'SVCB');
  // The direct endpoint record (target "." = this key itself) carries the
  // pubky-TLS port and IP hints; the domain record targets the ICANN name.
  const direct = https.find((r) => !r.rdata?.target || r.rdata.target === '.');
  const domainRec = https
    .filter((r) => r.rdata?.target && r.rdata.target !== '.')
    .sort((a, b) => (a.rdata?.priority ?? 0) - (b.rdata?.priority ?? 0))[0];

  const params = direct?.rdata?.params ?? {};
  const ipv4 = typeof params.ipv4hint === 'string' ? params.ipv4hint : null;
  const ipv6 = typeof params.ipv6hint === 'string' ? params.ipv6hint : null;
  const a = root.find((r) => r.rdata?.type === 'A')?.rdata?.address ?? null;
  const aaaa = root.find((r) => r.rdata?.type === 'AAAA')?.rdata?.address ?? null;
  const portRaw = params.port;
  const port =
    typeof portRaw === 'string' && /^\d{1,5}$/.test(portRaw)
      ? Number(portRaw)
      : typeof portRaw === 'number'
        ? portRaw
        : null;

  const host = ipv4 ?? a ?? ipv6 ?? aaaa;
  const candidates = [ipv4, a, ipv6, aaaa].filter((h): h is string => Boolean(h)).map(canonHost);
  const domain = domainRec?.rdata?.target ? stripDot(domainRec.rdata.target.toLowerCase()) : null;
  return {
    address: host ? (port !== null ? `${host}:${port}` : host) : null,
    addressHost: host ? canonHost(host) : null,
    addressPort: port,
    addressHostCandidates: [...new Set(candidates)],
    domain,
  };
}

/**
 * Pure verdict computation. Gate semantics: with a packet in hand, an
 * expectation that the packet contradicts OR cannot satisfy (record absent)
 * is a mismatch; 'not_compared' is reserved for absent/unparseable
 * expectations. Packet age NEVER affects the verdict - an old-but-correct
 * record is fine (user decision); age is returned for display only.
 */
export function computePkarrVerdict(facts: PkarrPacketFacts, expected: PkarrExpected): PkarrCheckResult {
  const records = asRecords(facts.records);
  const published = extractPublished(records, facts.pubkey);
  const timestampMs = Number.isFinite(facts.timestampUs) ? Math.round(facts.timestampUs / 1000) : null;

  const result: PkarrCheckResult = {
    verdict: 'verified',
    gates: { address: 'not_compared', domain: 'not_compared' },
    published: { address: published.address, domain: published.domain },
    expected: { address: expected.address ?? null, domain: expected.domain ?? null },
    timestamp_ms: timestampMs,
    packet_age_ms: timestampMs !== null ? Math.max(0, Date.now() - timestampMs) : null,
    records: summarizeRecords(facts.records, facts.pubkey),
  };

  if (!facts.valid) {
    result.verdict = 'invalid';
    return result;
  }

  if (expected.address) {
    const interpretations = addressInterpretations(expected.address);
    if (interpretations.length > 0) {
      const anyMatch = interpretations.some((exp) => {
        const hostOk = published.addressHostCandidates.includes(exp.host);
        // The port is only decisive when both sides state one.
        const portOk = exp.port === null || published.addressPort === null || exp.port === published.addressPort;
        return hostOk && portOk;
      });
      result.gates.address = anyMatch ? 'match' : 'mismatch';
    }
  }

  if (expected.domain) {
    const exp = splitHostPort(expected.domain);
    if (exp && exp.host && isIP(exp.host) === 0) {
      result.gates.domain = published.domain === exp.host ? 'match' : 'mismatch';
    }
  }

  if (result.gates.address === 'mismatch' || result.gates.domain === 'mismatch') {
    result.verdict = 'mismatch';
  }
  return result;
}

/** Humanizes the package's record objects for the viewer: '@' for the
 * origin, '<label>' for subrecords, params flattened to "k=v". */
export function summarizeRecords(rawRecords: unknown[], pubkey: string): PkarrRecordSummary[] {
  return asRecords(rawRecords).map((rec) => {
    const fullName = stripDot((rec.name ?? '').toLowerCase());
    const origin = pubkey.toLowerCase();
    let name: string;
    if (fullName === origin || fullName === '' || fullName === '.') name = '@';
    else if (fullName.endsWith(`.${origin}`)) name = fullName.slice(0, -(origin.length + 1));
    else name = fullName;

    const rdata = rec.rdata ?? {};
    const type = rdata.type ?? 'UNKNOWN';
    let value: string;
    if (type === 'HTTPS' || type === 'SVCB') {
      const params = Object.entries(rdata.params ?? {})
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(' ');
      value = `${rdata.priority ?? 0} ${rdata.target || '.'}${params ? ` ${params}` : ''}`;
    } else if (type === 'A' || type === 'AAAA') {
      value = rdata.address ?? '';
    } else if (typeof rdata.value === 'string') {
      value = rdata.value;
    } else {
      const { type: _omit, ...rest } = rdata;
      value = JSON.stringify(rest);
    }
    return { name, type, value, ttl: rec.ttl ?? 0 };
  });
}

// ---------------------------------------------------------------------------
// Resolution (network)
// ---------------------------------------------------------------------------

export type PkarrResolveOutcome =
  | { status: 'found'; facts: PkarrPacketFacts }
  | { status: 'not_found' }
  | { status: 'unavailable' };

/** z-base-32 decode of a 52-char pkarr pubkey into its 32 bytes. */
export function z32DecodePubkey(pubkey: string): Uint8Array {
  let bits = 0;
  let acc = 0;
  const out = new Uint8Array(32);
  let o = 0;
  for (const ch of pubkey) {
    const v = Z32_ALPHABET.indexOf(ch);
    if (v === -1) throw new Error(`invalid z-base-32 character: ${ch}`);
    acc = (acc << 5) | v;
    bits += 5;
    if (bits >= 8 && o < 32) {
      bits -= 8;
      out[o++] = (acc >>> bits) & 0xff;
    }
  }
  if (o !== 32) throw new Error('z-base-32 pubkey did not decode to 32 bytes');
  return out;
}

/** Ed25519 SPKI DER prefix for a raw 32-byte key (RFC 8410). */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/**
 * Verifies a raw relay payload (sig(64) + timestamp(8, u64 BE microseconds)
 * + DNS wire bytes) against a pubkey: the BEP44 mutable-item signature over
 * the bencoded "3:seqi{ts}e1:v{len}:{dns}".
 *
 * This is OUR verification, deliberately not the package's: isValid() on
 * fromBytes-rebuilt packets returns true even under the WRONG pubkey
 * (from_bytes trusts its input as pre-verified), so a malicious or buggy
 * relay could otherwise hand us someone else's record.
 */
export function verifyRelayPayload(pubkeyBytes: Uint8Array, payload: Uint8Array): boolean {
  if (payload.length < 72 || pubkeyBytes.length !== 32) return false;
  const sig = payload.subarray(0, 64);
  const ts = new DataView(payload.buffer, payload.byteOffset + 64, 8).getBigUint64(0, false);
  const v = payload.subarray(72);
  const signable = Buffer.concat([Buffer.from(`3:seqi${ts}e1:v${v.length}:`, 'ascii'), Buffer.from(v)]);
  try {
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(pubkeyBytes)]),
      format: 'der',
      type: 'spki',
    });
    return ed25519Verify(null, signable, key, Buffer.from(sig));
  } catch {
    return false;
  }
}

/** pubkey is passed in rather than read off the packet (the publicKeyString
 * getter hits a WASM panic on fromBytes-rebuilt packets), and validity is
 * OUR ed25519 check over the packet's relay payload - never the package's
 * isValid(), which cannot be trusted for relay-fetched data (see
 * verifyRelayPayload). bytes() = 40-byte prefix + relay payload. */
function packetFacts(packet: SignedPacket, pubkey: string): PkarrPacketFacts {
  return {
    pubkey,
    valid: verifyRelayPayload(z32DecodePubkey(pubkey), packet.bytes().slice(40)),
    timestampUs: packet.timestampMs, // upstream bug: microseconds
    records: packet.records,
  };
}

/** Rebuilds a SignedPacket from a raw relay payload (sig+ts+dns). bytes()
 * format is pubkey(32) + last_seen(8, value irrelevant) + relay payload.
 * Parsing only - validity comes from verifyRelayPayload. */
export function packetFromRelayPayload(pubkey: string, payload: Uint8Array): SignedPacket {
  const prefixed = new Uint8Array(40 + payload.length);
  prefixed.set(z32DecodePubkey(pubkey), 0);
  prefixed.set(payload, 40);
  return SignedPacket.fromBytes(prefixed);
}

/**
 * Resolves the newest packet for a pubkey across the relays. When the WASM
 * client comes back empty, raw fetches classify the emptiness: any relay
 * 200 means the client missed a record that exists (parse it ourselves),
 * any 404 means no record is published, anything else means the relays
 * were unreachable and nothing can be concluded about the server.
 */
export async function resolvePkarr(pubkey: string): Promise<PkarrResolveOutcome> {
  const relays = getPkarrRelays();
  let packet: SignedPacket | undefined;
  try {
    packet = await new Client(relays, RESOLVE_TIMEOUT_MS).resolveMostRecent(pubkey);
  } catch {
    packet = undefined;
  }
  if (packet) return { status: 'found', facts: packetFacts(packet, pubkey) };

  const probes = await Promise.allSettled(
    relays.map((relay) =>
      fetch(`${relay}/${pubkey}`, {
        signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
        headers: { 'User-Agent': 'Pubky-Homeserver-Dashboard/1' },
        // A relay is semi-trusted: do not follow a redirect to an internal
        // address (the project hardened the upstream proxies the same way).
        // A 3xx is treated as "no usable answer here" and falls through.
        redirect: 'error',
      }),
    ),
  );
  for (const probe of probes) {
    if (probe.status !== 'fulfilled' || probe.value.status !== 200) continue;
    try {
      const buf = await probe.value.arrayBuffer();
      if (buf.byteLength > MAX_RELAY_PAYLOAD_BYTES) continue; // oversized: not a real record
      const payload = new Uint8Array(buf);
      return { status: 'found', facts: packetFacts(packetFromRelayPayload(pubkey, payload), pubkey) };
    } catch {
      // malformed payload from this relay; let the others classify
    }
  }
  if (probes.some((p) => p.status === 'fulfilled' && p.value.status === 404)) {
    return { status: 'not_found' };
  }
  return { status: 'unavailable' };
}
