'use client';

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { ButtonSpinner } from '@/components/ui/button-spinner';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Info, Copy, Check, X, CircleCheckBig, RefreshCw, ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import { usePolling } from '@/hooks/usePolling';
import { QRCodeSVG } from 'qrcode.react';
import {
  QUOTA_FIELDS,
  type QuotaText,
  defaultText,
  describeLimits,
  emptyQuotaText,
  quotaLimits,
} from '@/lib/quota-form';
import type { UserQuota } from '@/services/admin/admin.types';

/** How often the signup-code stats are re-read while a new invite is on screen. */
const WATCH_POLL_MS = 3000;

/** How long a shown invite keeps polling before it stops on its own. */
const WATCH_TIMEOUT_MS = 5 * 60 * 1000;

export interface InviteManagementProps {
  /** Creates an invite with the given limits (none = the homeserver's defaults) and returns its code. */
  onGenerate: (limits: UserQuota) => Promise<string>;
  isGenerating?: boolean;
  /** Last invite-generation failure; rendered as an inline alert. */
  generateError?: string | null;
  signupCodesTotal?: number;
  signupCodesUnused?: number;
  isStatsLoading?: boolean;
  homeserverPubkey?: string;
  /** Background re-read of the signup-code stats, polled while a new invite is shown. */
  onRefreshStats?: () => void | Promise<void>;
  /** The homeserver's default limits (from its config.toml), shown in the empty fields; null when not readable. */
  homeserverDefaults?: UserQuota | null;
  /** Whether the page lists the homeserver's codes below this card; without the list a code cannot be shown again. */
  codesListed?: boolean;
}

/** The invite just created, shown once: the homeserver does not display codes again. */
type CreatedInvite = { token: string; limits: UserQuota };

/** "Get Pubky Ring" assist, shown wherever the app is a prerequisite. */
function PubkyRingAssist() {
  return (
    <p className="text-xs text-muted-foreground">
      Don&apos;t have Pubky Ring yet? Get it at{' '}
      <a
        href="https://pubkyring.app/"
        target="_blank"
        rel="noopener noreferrer"
        className="text-brand underline-offset-2 hover:underline"
      >
        pubkyring.app
      </a>
      .
    </p>
  );
}

export function InviteManagement({
  onGenerate,
  isGenerating,
  generateError,
  signupCodesTotal,
  signupCodesUnused,
  isStatsLoading,
  homeserverPubkey,
  onRefreshStats,
  homeserverDefaults,
  codesListed,
}: InviteManagementProps) {
  const { copiedKey, copy } = useCopyFeedback();
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [limitsOpen, setLimitsOpen] = useState(false);
  const [limitsText, setLimitsText] = useState<QuotaText>(emptyQuotaText);
  const [limitsError, setLimitsError] = useState<string | null>(null);
  const [sawSignup, setSawSignup] = useState(false);
  const [watchExpired, setWatchExpired] = useState(false);

  const hasStats = typeof signupCodesTotal === 'number' && typeof signupCodesUnused === 'number';
  const totalGenerated = hasStats ? signupCodesTotal : undefined;
  const totalUnused = hasStats ? signupCodesUnused : undefined;
  const totalUsed = hasStats ? Math.max(0, signupCodesTotal - signupCodesUnused) : undefined;

  const isWatching = created !== null && !watchExpired && !sawSignup;
  usePolling(() => onRefreshStats?.(), WATCH_POLL_MS, { enabled: isWatching && Boolean(onRefreshStats) });

  // Give up on an unattended panel rather than polling the homeserver forever.
  useEffect(() => {
    setWatchExpired(false);
    if (!created) return;
    const timer = setTimeout(() => setWatchExpired(true), WATCH_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [created]);

  // A signup shows up as the used count going up. Watching "used" rather than
  // "unused" survives an invite being created in the same interval, which moves
  // both other counters. The admin API reports totals only, so the panel
  // reports the signup and never claims it was this code.
  const previousUsedRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    const previousUsed = previousUsedRef.current;
    previousUsedRef.current = totalUsed;
    if (previousUsed === undefined || totalUsed === undefined) return;
    if (totalUsed <= previousUsed || !created) return;
    setSawSignup(true);
  }, [totalUsed, created]);

  // `direct_signup` registers the account on this homeserver straight away. The
  // plain `signup` intent is the relayed cookie flow and needs caps/relay/secret,
  // which an invite has none of.
  const signupUrl =
    created && homeserverPubkey
      ? `pubkyauth://direct_signup?hs=${encodeURIComponent(homeserverPubkey)}&st=${encodeURIComponent(created.token)}`
      : null;

  const createdLimitLines = created ? describeLimits(created.limits) : [];

  const handleCreate = async () => {
    setLimitsError(null);
    let limits: UserQuota = {};
    if (limitsOpen) {
      try {
        limits = quotaLimits(limitsText);
      } catch (error) {
        setLimitsError(error instanceof Error ? error.message : 'Could not read the limits.');
        return;
      }
    }
    try {
      const token = await onGenerate(limits);
      setSawSignup(false);
      setCreated({ token, limits });
    } catch {
      // Reported through generateError by the caller.
    }
  };

  const copyButton = (value: string, key: string, label: string) => (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => void copy(value, key)}
      className="h-8 w-8 shrink-0"
      title={copiedKey === key ? 'Copied' : label}
      aria-label={copiedKey === key ? `Copied: ${label}` : label}
    >
      {copiedKey === key ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
    </Button>
  );

  return (
    <Card>
      <CardHeader className="pb-4">
        <CardTitle className="flex items-center gap-2 text-base sm:text-lg">Invite Management</CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          Create invite codes for new users, with the homeserver&apos;s default limits or their own.
        </CardDescription>
      </CardHeader>

      <div className="mx-6 h-px bg-border/60" />

      <CardContent className="space-y-6 pt-4">
        {/* Invite Statistics */}
        <div>
          <div className="mb-3 flex items-center gap-2">
            <h3 className="text-sm font-medium text-foreground">Invite statistics</h3>
            {!hasStats && (
              <Badge variant="outline" className="border-dashed text-xs font-normal">
                <Info className="mr-1 h-3 w-3" />
                Unavailable
              </Badge>
            )}
          </div>
          <div className="grid grid-cols-3 gap-3 sm:gap-4">
            {(
              [
                [totalGenerated, 'Total generated'],
                [totalUsed, 'Used'],
                [totalUnused, 'Unused'],
              ] as const
            ).map(([value, label]) => (
              <div key={label} className="rounded-lg border bg-muted/30 p-4 text-center">
                <div className="text-2xl font-bold tabular-nums">
                  {isStatsLoading ? <Skeleton className="mx-auto h-7 w-10" /> : (value ?? '-')}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">{label}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Create an invite, with or without limits of its own. */}
        <div className="space-y-3" data-testid="invite-create-section">
          <h3 className="text-sm font-medium text-foreground">Create invite</h3>

          {generateError && !limitsError && (
            <Alert variant="destructive" data-testid="invite-generate-error">
              <AlertTitle>Could not create an invite</AlertTitle>
              <AlertDescription className="text-xs">
                <p className="break-words">{generateError}</p>
                <p className="mt-1">
                  No code was created. If limits were set, check them; otherwise the homeserver may be busy or
                  restarting, so wait a moment and try again.
                </p>
              </AlertDescription>
            </Alert>
          )}

          {limitsError && (
            <Alert variant="destructive" data-testid="invite-limits-error">
              <AlertTitle>Check the limits</AlertTitle>
              <AlertDescription className="text-xs">{limitsError}</AlertDescription>
            </Alert>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void handleCreate()} disabled={isGenerating} size="sm" data-testid="invite-create">
              {isGenerating ? <ButtonSpinner className="mr-2" /> : <Plus className="h-4 w-4" />}
              {isGenerating ? 'Creating...' : 'Create invite'}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setLimitsOpen((open) => !open)}
              aria-expanded={limitsOpen}
              data-testid="invite-limits-toggle"
            >
              {limitsOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              {limitsOpen ? 'Hide limits' : 'Set limits for this invite'}
            </Button>
          </div>

          {limitsOpen && (
            <div className="space-y-4 rounded-lg border bg-muted/30 p-4" data-testid="invite-limits">
              <p className="text-xs text-muted-foreground">
                Whoever signs up with this invite gets these limits. Empty fields follow the homeserver&apos;s defaults.
              </p>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {QUOTA_FIELDS.map(({ key, label, hint }) => (
                  <div key={key} className="space-y-1.5">
                    <Label htmlFor={`invite-${key}`}>{label}</Label>
                    <Input
                      id={`invite-${key}`}
                      value={limitsText[key]}
                      onChange={(event) => setLimitsText({ ...limitsText, [key]: event.target.value })}
                      placeholder={
                        homeserverDefaults
                          ? `${defaultText(key, homeserverDefaults)} (homeserver default)`
                          : 'homeserver default'
                      }
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground/70">{hint}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {created && (
            <div className="rounded-lg border bg-muted/40 p-3 sm:p-4" data-testid="invite-created">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1">
                  <span className="mb-1 block text-xs font-medium text-muted-foreground">New invite</span>
                  <code
                    className="font-mono text-xs break-all sm:text-sm sm:break-normal"
                    data-testid="invite-created-code"
                  >
                    {created.token}
                  </code>
                </div>
                <div className="flex shrink-0 gap-2">
                  {copyButton(created.token, 'code', 'Copy invite code')}
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => setCreated(null)}
                    className="h-8 w-8"
                    title="Done with this invite"
                    aria-label="Done with this invite"
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              <p className="mt-2 text-xs text-muted-foreground/70" data-testid="invite-limits-summary">
                {createdLimitLines.length === 0
                  ? "Limits: the homeserver's defaults."
                  : `Limits: ${createdLimitLines.join('; ')}.`}{' '}
                {codesListed
                  ? 'The code stays valid after a reload and is listed under Invite codes below, but is shown with its QR code only now.'
                  : 'The code stays valid after a reload, but it is shown only now: copy it before leaving this page.'}
              </p>

              {sawSignup && (
                <div
                  data-testid="invite-signup-seen"
                  className="mt-4 animate-in rounded-lg border border-brand bg-brand/16 p-4 fade-in"
                >
                  <div className="flex items-start gap-2">
                    <CircleCheckBig className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground">Someone just joined</p>
                      <p className="text-xs text-muted-foreground">
                        An invite code was used while this one was on screen. The homeserver only reports totals, so if
                        it was this code, it will not work a second time.
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {signupUrl && (
                <div className="mt-4 rounded-lg border bg-muted/30 p-4">
                  <p className="mb-3 text-xs font-medium text-muted-foreground">
                    Share invite - scan with Pubky Ring or copy the link
                  </p>
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6">
                    <div className="flex shrink-0 flex-col items-center gap-2">
                      <div className="rounded-lg border border-border bg-white p-3 shadow-sm">
                        <QRCodeSVG value={signupUrl} size={160} level="M" />
                      </div>
                      <span className="text-xs text-muted-foreground">QR code</span>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 rounded-md border bg-background px-3 py-2">
                        <code className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">{signupUrl}</code>
                        {copyButton(signupUrl, 'url', 'Copy invite URL')}
                      </div>
                      <p className="mt-2 text-xs text-muted-foreground/70">
                        The <code>pubkyauth://</code> link only opens on a device with Pubky Ring installed.
                      </p>
                      <div className="mt-1">
                        <PubkyRingAssist />
                      </div>
                      {isWatching && onRefreshStats && (
                        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <RefreshCw className="h-3 w-3 animate-spin" /> Waiting for a signup…
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
