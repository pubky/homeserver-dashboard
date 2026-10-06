import { NextRequest, NextResponse } from 'next/server';
import { signInRequest } from '@/lib/server/auth/guard';
import { signInCapability } from '@/lib/server/auth/sign-in';
import { CHALLENGE_TTL_MS, createChallenge } from '@/lib/server/auth/store';

export const dynamic = 'force-dynamic';

/**
 * POST /api/auth/challenge
 * Starts a sign-in attempt. Returns the capability to ask Pubky Ring to sign
 * (it names this one attempt) and a verifier the browser keeps to itself and
 * sends back with the signed token. Public by nature: it is the first step of
 * signing in.
 */
export async function POST(request: NextRequest) {
  const { config, refusal } = signInRequest(request);
  if (refusal) return refusal;

  const { nonce, verifier } = createChallenge();
  return NextResponse.json(
    {
      capability: signInCapability(nonce),
      verifier,
      relay: config.relay,
      expiresInSecs: Math.floor(CHALLENGE_TTL_MS / 1000),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
