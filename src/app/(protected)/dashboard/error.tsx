'use client';

import { Button } from '@/components/ui/button';

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center p-6">
      <div className="w-full max-w-xl space-y-3 rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
        <h2 className="text-lg font-semibold">Dashboard section unavailable</h2>
        <p className="text-sm text-muted-foreground">
          This part of the dashboard failed to load. You can retry without leaving the page.
        </p>
        {error.digest ? (
          <p className="rounded-md bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            Error ID: {error.digest}
          </p>
        ) : null}
        <Button onClick={reset} size="sm">
          Retry section
        </Button>
      </div>
    </div>
  );
}
