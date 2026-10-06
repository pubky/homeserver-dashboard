import { NextRequest, NextResponse } from 'next/server';
import { signInRequest } from '@/lib/server/auth/guard';
import { formatPubky } from '@/lib/server/auth/pubky-key';
import { MAX_TOKEN_LENGTH } from '@/lib/server/auth/ring-token';
import { setSessionCookie } from '@/lib/server/auth/session-cookie';
import { type SignInResult, signIn } from '@/lib/server/auth/sign-in';
import { RouteError, errorResponse } from '@/lib/server/errors';
import { getRequestId, logRouteError, logRouteInfo } from '@/lib/server/logger';

export const dynamic = 'force-dynamic';

const ROUTE_NAME = '/api/auth/login';
/** A base64 token of the maximum size plus the verifier, with room to spare. */
const MAX_BODY_BYTES = 2 * MAX_TOKEN_LENGTH;
const BASE64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

type LoginBody = { token: Uint8Array; verifier: string };

/**
 * The request body, or null when it is larger than `limit`. Read chunk by
 * chunk and abandoned at the limit: this route is open to anyone, and a body
 * sent without a Content-Length would otherwise be buffered whole.
 */
async function readAtMost(request: NextRequest, limit: number): Promise<Buffer | null> {
  if (Number(request.headers.get('content-length') ?? 0) > limit) return null;
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
}

async function readBody(request: NextRequest): Promise<LoginBody | null> {
  const raw = await readAtMost(request, MAX_BODY_BYTES);
  if (!raw || raw.byteLength === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { token, verifier } = parsed as { token?: unknown; verifier?: unknown };
  if (typeof token !== 'string' || typeof verifier !== 'string') return null;
  if (!BASE64.test(token) || verifier.length === 0 || verifier.length > 128) return null;
  return { token: new Uint8Array(Buffer.from(token, 'base64')), verifier };
}

const BAD_BODY = new RouteError(400, 'bad_request', 'Expected a JSON body with token and verifier');
const REFUSALS = {
  invalid_token: new RouteError(401, 'unauthorized', 'The sign-in from Pubky Ring is not valid or has expired'),
  not_admin: new RouteError(403, 'forbidden', 'This pubky is not an admin of this dashboard'),
  wrong_attempt: new RouteError(401, 'unauthorized', 'This sign-in was not started in this browser, or it has expired'),
};

/** A refused sign-in: logged with what is known about who tried, answered with the reason. */
function refused(result: Extract<SignInResult, { ok: false }>, requestId: string): NextResponse {
  const error = REFUSALS[result.reason];
  logRouteError({
    requestId,
    route: ROUTE_NAME,
    method: 'POST',
    statusCode: error.status,
    errorType: error.type,
    message: error.message,
    meta: { reason: result.reason, signer: result.reason === 'not_admin' ? formatPubky(result.signer) : undefined },
  });
  return errorResponse(error, requestId);
}

/**
 * POST /api/auth/login
 * Body: `{ token, verifier }` - the token Pubky Ring signed (base64) and the
 * verifier from /api/auth/challenge. On success sets the session cookie.
 * See lib/server/auth/sign-in.ts for what is checked and why.
 */
export async function POST(request: NextRequest) {
  const { config, refusal } = signInRequest(request);
  if (refusal) return refusal;

  const requestId = getRequestId(request);
  const body = await readBody(request);
  if (!body) return errorResponse(BAD_BODY, requestId);

  const result = signIn(config, body.token, body.verifier);
  if (!result.ok) return refused(result, requestId);

  const pubky = formatPubky(result.admin);
  logRouteInfo({
    requestId,
    route: ROUTE_NAME,
    method: 'POST',
    statusCode: 200,
    message: 'Admin signed in',
    meta: { pubky },
  });
  const response = NextResponse.json({ pubky, requestId }, { headers: { 'Cache-Control': 'no-store' } });
  setSessionCookie(response, request, result.sessionId);
  return response;
}
