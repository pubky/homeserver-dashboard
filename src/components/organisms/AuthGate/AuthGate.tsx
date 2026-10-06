'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { installDashboardRequestHeader } from '@/lib/dashboard-request';
import { SignIn } from './SignIn';

/** How often a signed-in page checks that its session is still alive. */
const SESSION_CHECK_MS = 30_000;

type Status =
  | { state: 'loading' }
  /** The server asks for no sign-in (ADMIN_PUBKEYS is not set). */
  | { state: 'open' }
  | { state: 'signed-in'; pubky: string }
  | { state: 'signed-out' }
  /** The server refuses everything until its sign-in settings are fixed. */
  | { state: 'misconfigured'; reason: string }
  | { state: 'unreachable' };

type SessionResponse = { authRequired: boolean; authenticated?: boolean; pubky?: string; error?: string };

async function readStatus(): Promise<Status> {
  try {
    const response = await fetch('/api/auth/session', { cache: 'no-store' });
    if (!response.ok) return { state: 'unreachable' };
    const body = (await response.json()) as SessionResponse;
    if (body.authRequired === false) return { state: 'open' };
    if (body.error) return { state: 'misconfigured', reason: body.error };
    if (body.authenticated && body.pubky) return { state: 'signed-in', pubky: body.pubky };
    return { state: 'signed-out' };
  } catch {
    return { state: 'unreachable' };
  }
}

type AdminSession = { pubky: string; signOut: () => Promise<void> };

const AdminSessionContext = createContext<AdminSession | null>(null);

/** The signed-in admin, or null when the dashboard runs without sign-in. */
export function useAdminSession(): AdminSession | null {
  return useContext(AdminSessionContext);
}

function Notice({ title, children, onRetry }: { title: string; children: ReactNode; onRetry: () => void }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4 text-foreground">
      <div className="flex w-full max-w-md flex-col items-center gap-4">
        <Alert variant="destructive" data-testid="auth-notice">
          <AlertTitle>{title}</AlertTitle>
          <AlertDescription>{children}</AlertDescription>
        </Alert>
        <Button variant="outline" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

/**
 * Shows the dashboard only once the server says this browser may see it.
 *
 * This is for the page, not the protection: every API route refuses requests
 * without a session by itself. The gate keeps the dashboard from mounting
 * (and firing requests that would all fail) until there is a session, and
 * swaps back to the sign-in when the session ends.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>({ state: 'loading' });

  const refresh = useCallback(async () => {
    setStatus(await readStatus());
  }, []);

  useEffect(() => {
    // Before the first API request: with sign-in on, the API refuses requests
    // that do not carry the dashboard's own header.
    installDashboardRequestHeader();
    void refresh();
  }, [refresh]);

  const signedIn = status.state === 'signed-in';
  useEffect(() => {
    if (!signedIn) return;
    const timer = setInterval(() => void refresh(), SESSION_CHECK_MS);
    return () => clearInterval(timer);
  }, [signedIn, refresh]);

  const signOut = useCallback(async () => {
    try {
      await fetch('/api/auth/session', { method: 'DELETE', cache: 'no-store' });
    } finally {
      await refresh();
    }
  }, [refresh]);

  const pubky = status.state === 'signed-in' ? status.pubky : null;
  const session = useMemo(() => (pubky ? { pubky, signOut } : null), [pubky, signOut]);

  switch (status.state) {
    case 'loading':
      return <div className="min-h-screen bg-background" data-testid="auth-loading" />;
    case 'signed-out':
      return <SignIn onSignedIn={() => void refresh()} />;
    case 'misconfigured':
      return (
        <Notice title="Sign-in is misconfigured" onRetry={() => void refresh()}>
          {status.reason}. The dashboard stays closed until this is fixed on the server.
        </Notice>
      );
    case 'unreachable':
      return (
        <Notice title="Cannot reach the dashboard server" onRetry={() => void refresh()}>
          The sign-in status could not be read.
        </Notice>
      );
    case 'open':
    case 'signed-in':
      return <AdminSessionContext.Provider value={session}>{children}</AdminSessionContext.Provider>;
  }
}
