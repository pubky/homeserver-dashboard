import { NextRequest, NextResponse } from 'next/server';
import { withAdminAuth } from '@/lib/server/auth/guard';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { Z32_PUBKEY_RE, computePkarrVerdict, resolvePkarr, type PkarrCheckResult } from '@/lib/server/pkarr-verify';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';

const ROUTE_NAME = '/api/pkarr-health';
/** /info values are "host:port" - far below this; anything bigger is junk. */
const MAX_EXPECTED_LEN = 260;

/**
 * GET /api/pkarr-health?pubkey=<z32>&expected_address=<ip:port>&expected_domain=<host[:port]>
 *
 * Fetches the homeserver's PKARR record from the pkarr relays, verifies its
 * signature, and reconciles it against what the homeserver believes it
 * published (the caller passes /info's pkarr_pubky_address and
 * pkarr_icann_domain). not_found and unavailable are check OUTCOMES (200 +
 * verdict), not transport errors: they are exactly what the Overview needs
 * to render.
 *
 * The pubkey is the only value interpolated into outbound URLs and is
 * validated to the z-base-32 alphabet first; the expectations are
 * comparison-only inputs.
 */
async function handleGet(request: NextRequest) {
  const requestId = getRequestId(request);
  const startedAt = Date.now();

  const pubkey = (request.nextUrl.searchParams.get('pubkey') ?? '').trim().toLowerCase();
  if (!Z32_PUBKEY_RE.test(pubkey)) {
    return errorResponse(new RouteError(400, 'bad_request', 'Missing or invalid pubkey'), requestId);
  }
  const expected: { address: string | null; domain: string | null } = { address: null, domain: null };
  for (const [key, param] of [
    ['address', 'expected_address'],
    ['domain', 'expected_domain'],
  ] as const) {
    const raw = request.nextUrl.searchParams.get(param);
    if (raw === null) continue;
    const value = raw.trim().toLowerCase();
    if (value.length > MAX_EXPECTED_LEN) {
      return errorResponse(new RouteError(400, 'bad_request', `${param} is too long`), requestId);
    }
    expected[key] = value || null;
  }

  try {
    const outcome = await resolvePkarr(pubkey);
    const result: PkarrCheckResult =
      outcome.status === 'found'
        ? computePkarrVerdict(outcome.facts, expected)
        : {
            verdict: outcome.status,
            gates: { address: 'not_compared', domain: 'not_compared' },
            published: { address: null, domain: null },
            expected,
            timestamp_ms: null,
            packet_age_ms: null,
            records: [],
          };
    logRouteInfo({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: 200,
      durationMs: Date.now() - startedAt,
      message: 'Pkarr verification completed',
      meta: { verdict: result.verdict, gates: result.gates },
    });
    return NextResponse.json({ ...result, requestId }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    const error = new RouteError(500, 'internal_error', 'Pkarr verification failed');
    logRouteError({
      requestId,
      route: ROUTE_NAME,
      method: 'GET',
      statusCode: error.status,
      durationMs: Date.now() - startedAt,
      errorType: error.type,
      message: e instanceof Error ? e.message : String(e),
    });
    return errorResponse(error, requestId);
  }
}

export const GET = withAdminAuth(handleGet);
