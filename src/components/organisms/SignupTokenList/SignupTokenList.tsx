'use client';

import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronUp, Copy, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useSignupTokens } from '@/hooks/admin';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import { formatUtcTimestamp, shortPubky } from '@/lib/format';
import { describeLimits } from '@/lib/quota-form';
import { cn } from '@/lib/utils';
import type { SignupToken, SignupTokenState, UserQuota } from '@/services/admin/admin.types';

export interface SignupTokenListProps {
  /** Bump to reload, e.g. after an invite was created. */
  refreshKey?: number;
}

/** Codes shown at first, and added by each "Show more". The list scrolls, so the page does not grow. */
const VISIBLE_STEP = 10;

const FILTERS: { value: SignupTokenState; label: string }[] = [
  { value: 'unused', label: 'Unused' },
  { value: 'used', label: 'Used' },
];

/** The limits a code carries, one per line. */
function TokenLimits({ quota }: { quota: UserQuota }) {
  const lines = describeLimits(quota);
  return (
    <ul className="mt-2 space-y-0.5 border-t pt-2 text-xs text-muted-foreground" data-testid="signup-token-limits">
      {lines.length === 0 ? (
        <li>The homeserver&apos;s default limits.</li>
      ) : (
        lines.map((line) => <li key={line}>{line}</li>)
      )}
    </ul>
  );
}

/**
 * Every invite code the homeserver has issued, unused or used, read from the
 * admin `GET /signup_tokens`. Used codes name the
 * pubky that signed up with them: on a homeserver that requires codes, that
 * is the list of who joined.
 */
export function SignupTokenList({ refreshKey = 0 }: SignupTokenListProps) {
  const [filter, setFilter] = useState<SignupTokenState>('unused');
  const { items, isLoading, error, refetch } = useSignupTokens(filter, refreshKey);
  const { copiedKey, copy } = useCopyFeedback();
  const [visible, setVisible] = useState(VISIBLE_STEP);
  const [limitsOpenFor, setLimitsOpenFor] = useState<string | null>(null);
  // Back to the top of a fresh list.
  useEffect(() => {
    setVisible(VISIBLE_STEP);
    setLimitsOpenFor(null);
  }, [items]);
  const reportsLimits = items.some((item) => item.quota !== undefined);

  const copyButton = (value: string, key: string, label: string) => (
    <Button
      variant={copiedKey === key ? 'secondary' : 'ghost'}
      size="icon"
      className="h-8 w-8 shrink-0"
      onClick={() => void copy(value, key)}
      title={copiedKey === key ? 'Copied' : label}
      aria-label={copiedKey === key ? `Copied: ${label}` : label}
    >
      {copiedKey === key ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </Button>
  );

  const row = (item: SignupToken) => (
    <div key={item.token} className="rounded-lg border bg-muted/40 p-3" data-testid="signup-token-row">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1">
          <code className="font-mono text-sm">{item.token}</code>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {item.used_at ? (
              <>
                Used {formatUtcTimestamp(item.used_at)}
                {item.used_by && (
                  <>
                    {' '}
                    by{' '}
                    <code className="font-mono" title={item.used_by}>
                      {shortPubky(item.used_by)}
                    </code>
                  </>
                )}
              </>
            ) : (
              <>Created {formatUtcTimestamp(item.created_at)}</>
            )}
          </p>
        </div>
        <div className="flex shrink-0 gap-1">
          {item.used_by
            ? copyButton(item.used_by, `pubky-${item.token}`, 'Copy pubky')
            : copyButton(item.token, `code-${item.token}`, 'Copy code')}
          {item.quota !== undefined && (
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1 px-2 text-xs"
              onClick={() => setLimitsOpenFor((open) => (open === item.token ? null : item.token))}
              aria-expanded={limitsOpenFor === item.token}
              aria-label={limitsOpenFor === item.token ? 'Hide limits' : 'Show limits'}
            >
              {limitsOpenFor === item.token ? (
                <ChevronUp className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
              Limits
            </Button>
          )}
        </div>
      </div>
      {item.quota !== undefined && limitsOpenFor === item.token && <TokenLimits quota={item.quota} />}
    </div>
  );

  return (
    <Card data-testid="signup-token-list">
      <CardHeader className="pb-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base sm:text-lg">Invite codes</CardTitle>
            <CardDescription className="text-xs sm:text-sm">
              Every code this homeserver has issued. Unused codes can still be shared; used ones show who signed up.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void refetch()}
            disabled={isLoading}
            title="Refresh"
            aria-label="Refresh invite codes"
          >
            <RefreshCw className={cn('h-4 w-4', isLoading && 'animate-spin')} />
          </Button>
        </div>
      </CardHeader>

      <div className="mx-6 h-px bg-border/60" />

      <CardContent className="space-y-4 pt-4">
        <div className="flex gap-2" role="group" aria-label="Show codes">
          {FILTERS.map(({ value, label }) => (
            <Button
              key={value}
              variant={filter === value ? 'default' : 'outline'}
              size="sm"
              onClick={() => setFilter(value)}
              aria-pressed={filter === value}
            >
              {label}
            </Button>
          ))}
        </div>

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Could not load invite codes</AlertTitle>
            <AlertDescription className="text-xs">{error.message}</AlertDescription>
          </Alert>
        )}

        {!isLoading && items.length > 0 && !reportsLimits && (
          <p className="text-xs text-muted-foreground/70" data-testid="limits-not-reported">
            This homeserver does not report a code&apos;s limits; newer ones do.
          </p>
        )}

        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : items.length === 0 && !error ? (
          <p className="rounded-lg border border-dashed bg-muted/30 px-4 py-8 text-center text-sm text-muted-foreground">
            {filter === 'unused' ? 'No unused codes.' : 'No code has been used yet.'}
          </p>
        ) : (
          // About five rows tall; the rest scrolls, and "Show more" sits at the bottom of the scroll.
          <div className="max-h-[23rem] space-y-2 overflow-y-auto pr-1" data-testid="signup-token-scroll">
            {items.slice(0, visible).map(row)}
            {items.length > visible && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setVisible((n) => n + VISIBLE_STEP)}
                className="w-full sm:w-auto"
                data-testid="signup-token-more"
              >
                Show more ({items.length - visible} left)
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
