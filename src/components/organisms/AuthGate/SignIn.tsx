'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { RefreshCw, ShieldCheck } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { startRingSignIn } from './ring-sign-in';

type Attempt =
  | { step: 'starting' }
  | { step: 'waiting'; authUrl: string }
  | { step: 'finishing' }
  | { step: 'failed'; message: string };

/** The admin sign-in screen: a QR code for Pubky Ring, and what became of the attempt. */
export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  const [attempt, setAttempt] = useState<Attempt>({ step: 'starting' });
  // Each start() gets a number; a result that belongs to an older one is dropped.
  const run = useRef(0);

  const start = useCallback(async () => {
    const thisRun = ++run.current;
    const current = () => run.current === thisRun;
    setAttempt({ step: 'starting' });
    try {
      const signIn = await startRingSignIn();
      if (!current()) return;
      setAttempt({ step: 'waiting', authUrl: signIn.authUrl });

      const token = await signIn.awaitApproval();
      if (!current()) return;
      setAttempt({ step: 'finishing' });

      await signIn.complete(token);
      if (current()) onSignedIn();
    } catch (error) {
      if (current()) setAttempt({ step: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }, [onSignedIn]);

  useEffect(() => {
    void start();
    const runs = run;
    return () => {
      // Unmounting abandons the attempt: whatever it returns later is ignored.
      runs.current += 1;
    };
  }, [start]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <Card className="w-full max-w-md" data-testid="sign-in">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-xl">
            <ShieldCheck className="size-5" />
            Admin sign-in
          </CardTitle>
          <CardDescription>
            Scan with Pubky Ring to open the homeserver dashboard. Only pubkys listed as admins of this dashboard can
            sign in.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4">
          {attempt.step === 'starting' && <p className="text-sm text-muted-foreground">Preparing sign-in…</p>}

          {attempt.step === 'waiting' && (
            <>
              <div className="rounded-lg border border-border bg-white p-3 shadow-sm">
                <QRCodeSVG value={attempt.authUrl} size={220} level="M" data-testid="sign-in-qr" />
              </div>
              <p className="text-center text-sm text-muted-foreground">Waiting for approval in Pubky Ring…</p>
              <a href={attempt.authUrl} className="text-sm text-brand underline-offset-2 hover:underline">
                Open in Pubky Ring on this device
              </a>
              <p className="text-center text-xs text-muted-foreground">
                Approve only a sign-in you started yourself on this page. Ring will show a request for{' '}
                <code className="font-mono">/homeserver-dashboard/signin/…</code>
              </p>
            </>
          )}

          {attempt.step === 'finishing' && <p className="text-sm text-muted-foreground">Signing in…</p>}

          {attempt.step === 'failed' && (
            <>
              <Alert variant="destructive" data-testid="sign-in-error">
                <AlertTitle>Sign-in failed</AlertTitle>
                <AlertDescription>{attempt.message}</AlertDescription>
              </Alert>
              <Button onClick={() => void start()} className="gap-2">
                <RefreshCw className="size-4" />
                Try again
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
