'use client';

import { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge, badgeVariants } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { CircleCheckBig, AlertCircle, Copy, RefreshCw, ExternalLink, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import { RestartCallout } from '@/components/organisms/ConfigDialog/RestartCallout';
import { useRestartSentence } from '@/hooks/useRestartSentence';
import { usePlatform } from '@/components/providers/PlatformProvider';
import { classifyAddress, type AddressScope } from '@/lib/address-scope';
import { publicAddressLink } from '@/lib/public-address';
import { GetStartedChecklist } from './GetStartedChecklist';
import { PkarrRecordViewer } from './PkarrRecordViewer';
import type { DashboardOverviewProps, PkarrHealthResponse, PkarrVerdict } from './DashboardOverview.types';

type DomainHealth = 'not_set_up' | 'checking' | 'reachable' | 'unreachable';

/** 'unknown' = no pubkey yet / nothing to check. The rest mirror the
 * /api/pkarr-health verdicts one-to-one. */
type PkarrHealth = 'unknown' | 'checking' | PkarrVerdict;

/**
 * Last-known Overview state, cached at module scope (lives for the page's
 * lifetime). The dashboard's tabs unmount inactive content, so without this a
 * tab switch and return would reset domain health and Cloudflare mode to their
 * defaults and flash the get-started checklist back to "incomplete" for the
 * ~1s the refetch/probe takes. The effects still re-validate on every mount;
 * the cache only seeds the initial render and is silently refreshed.
 */
const overviewStateCache: {
  // The cached health verdict is keyed by the hostname it was measured for, so
  // a domain change does not let a stale "reachable" mark the new hostname as
  // reachable before its own probe runs.
  domainHostname?: string | null;
  domainHealth?: DomainHealth;
  restartPending?: boolean;
  cloudflareMode?: string | null;
  // Keyed by pubkey + both expectations: any of them changing re-verifies
  // from scratch instead of inheriting the old verdict.
  pkarrKey?: string | null;
  pkarrHealth?: PkarrHealth;
  pkarrResult?: PkarrHealthResponse | null;
} = {};

/** Test-only: the cache is module-scoped and persists across renders by design
 * (that is what survives tab switches), which leaks state between test cases. */
export function __resetOverviewStateCache() {
  overviewStateCache.domainHostname = undefined;
  overviewStateCache.domainHealth = undefined;
  overviewStateCache.restartPending = undefined;
  overviewStateCache.cloudflareMode = undefined;
  overviewStateCache.pkarrKey = undefined;
  overviewStateCache.pkarrHealth = undefined;
  overviewStateCache.pkarrResult = undefined;
}

/** "localhost:6286" / missing -> the operator never set up public access. */
function domainHostname(pkarrIcannDomain: string | undefined): string | null {
  const hostname = (pkarrIcannDomain ?? '').split(':')[0].trim().toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) return null;
  return hostname;
}

/** Connection failure explained for the operator first (on Umbrel there is
 * nothing for them to configure); the settings checklist only matters to
 * whoever set the dashboard up and lives behind a collapsed disclosure. */
function ConnectionErrorAlert({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const restartSentence = useRestartSentence();
  return (
    <Alert variant="destructive" data-testid="connection-error">
      <AlertTitle>Connection Error</AlertTitle>
      <AlertDescription className="text-xs">
        <p>Your homeserver may still be starting. Wait a minute - this page retries automatically.</p>
        <p className="mt-1">If this persists: {restartSentence}</p>
        {onRetry && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="mt-2 h-7 px-2 text-xs"
            onClick={onRetry}
            data-testid="connection-retry"
          >
            <RefreshCw className="mr-1 h-3 w-3" />
            Retry now
          </Button>
        )}
        <details className="mt-2" data-testid="connection-dev-details">
          <summary className="cursor-pointer font-medium">Developer details</summary>
          <p className="mt-1 break-words">{message}</p>
          <ul className="mt-1 list-inside list-disc space-y-0.5">
            <li>Missing or incorrect ADMIN_BASE_URL or ADMIN_TOKEN</li>
            <li>Without those: HOMESERVER_CONFIG_PATH does not point at a config.toml the dashboard can read</li>
            <li>Homeserver is not running or unreachable</li>
          </ul>
        </details>
      </AlertDescription>
    </Alert>
  );
}

/** /info does not include this field: say so instead of inventing a value. */
function NotAvailable() {
  return (
    <div className="flex min-w-0 flex-col sm:items-end">
      <span className="text-xs text-foreground sm:text-sm">Not available</span>
      <span className="text-xs text-muted-foreground">Not reported by this homeserver (it may be too old)</span>
    </div>
  );
}

/** Per-scope badge copy. Hostnames and unparseable values get no badge: a
 * name's reachability depends on what it resolves to, which the reachability
 * chip on the Public address row already answers. */
const ADDRESS_SCOPE_BADGES: Partial<Record<AddressScope, { label: string; title: string; className: string }>> = {
  loopback: {
    label: 'Localhost only',
    title: 'Only this machine can reach this address. Other devices and Pubky apps cannot connect through it.',
    className: 'border-amber-400/40 text-amber-400',
  },
  private: {
    label: 'Private network',
    title:
      'This is a private network address (LAN or Docker). Devices on the internet cannot reach your server through it. Set up a public address so Pubky apps can find you.',
    className: 'border-amber-400/40 text-amber-400',
  },
  public: {
    label: 'Public IP',
    title:
      'This looks like a publicly routable IP address. Reachability from outside your network cannot be verified from here.',
    className: 'text-muted-foreground',
  },
};

/** Tells the operator whether anyone else could reach a published IP address
 * (a past config bug published docker-internal IPs that look fine but are
 * unreachable). Renders nothing for hostnames and non-addresses. */
function AddressScopeBadge({ address }: { address: string }) {
  const scope = classifyAddress(address);
  const badge = ADDRESS_SCOPE_BADGES[scope];
  if (!badge) return null;
  return (
    <Badge
      variant="outline"
      className={cn('shrink-0', badge.className)}
      title={badge.title}
      data-testid="address-scope-badge"
      data-scope={scope}
    >
      {badge.label}
    </Badge>
  );
}

/** Flags the published address as a throwaway Preview tunnel so the operator
 * knows its limits (a *.trycloudflare.com Quick Tunnel, or the dashboard's own
 * preview mode). Clicking the badge opens a dialog that explains the limits in
 * plain terms and, on Umbrel, offers a shortcut to the full Cloudflare setup.
 * `onSetUpCloudflare` is omitted where that setup is unavailable (standalone),
 * in which case the dialog is purely informational. */
function PreviewModeBadge({ onSetUpCloudflare }: { onSetUpCloudflare?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className={cn(
            badgeVariants({ variant: 'outline' }),
            'shrink-0 cursor-pointer gap-1 border-amber-400/40 text-amber-400 hover:border-amber-400/70 hover:text-amber-300',
          )}
          data-testid="preview-mode-badge"
        >
          Preview mode
          <Info className="h-3 w-3" aria-hidden />
        </button>
      </DialogTrigger>
      <DialogContent data-testid="preview-mode-dialog">
        <DialogHeader>
          <DialogTitle>Preview mode</DialogTitle>
          <DialogDescription>
            Your homeserver is online through a temporary Cloudflare Preview tunnel. It&apos;s the fastest way to get
            started — no Cloudflare account or domain needed — but it isn&apos;t built to last:
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-3 text-sm text-muted-foreground">
          <li className="flex gap-2">
            <span aria-hidden className="text-amber-400">
              •
            </span>
            <span>
              <span className="font-medium text-foreground">The address is temporary.</span> It can change, and may drop
              offline for a moment every time the app restarts.
            </span>
          </li>
          <li className="flex gap-2">
            <span aria-hidden className="text-amber-400">
              •
            </span>
            <span>
              <span className="font-medium text-foreground">Live updates don&apos;t get through.</span> Apps that follow
              your content as you post it (the <code className="font-mono text-xs">/events</code> stream) can&apos;t
              connect over a Preview tunnel, so the rest of the Pubky network may miss what you publish.
            </span>
          </li>
        </ul>
        <p className="text-sm text-muted-foreground">
          For an address that stays put and works everywhere, connect your own Cloudflare account and domain.
        </p>
        {onSetUpCloudflare && (
          <DialogFooter>
            <Button
              type="button"
              onClick={() => {
                setOpen(false);
                onSetUpCloudflare();
              }}
              data-testid="preview-mode-setup-cta"
            >
              Set up Cloudflare account &amp; domain
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CopyValueButton({ value, label }: { value: string; label: string }) {
  const { copiedKey, copy } = useCopyFeedback();
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="h-6 shrink-0 px-1.5"
      onClick={() => void copy(value)}
      aria-label={label}
    >
      {copiedKey ? <span className="text-xs text-brand">Copied</span> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

export function DashboardOverview({
  info,
  isLoading,
  error,
  onFixCloudflare,
  onRetry,
  onGoToInvites,
  setupGuideDismissed,
  onDismissSetupGuide,
  cloudflareRefreshKey,
}: DashboardOverviewProps) {
  const restartSentence = useRestartSentence();
  // Cloudflare setup is Umbrel-only; on standalone, hide its CTAs and the
  // get-started reachable step (reachability is set up outside the dashboard).
  const platform = usePlatform();
  const isConnected = !error && !!info;
  const connectionError = error?.message || (error ? 'Failed to load server information' : null);

  // Live reachability of the published domain. One probe when the domain
  // becomes known (no polling - this is the landing view), manual re-check.
  const probeHostname = domainHostname(info?.pkarr_icann_domain);
  // Only seed from cache when it was measured for the SAME hostname; a domain
  // change must re-probe from scratch, not inherit the old verdict.
  const cacheMatchesHost = overviewStateCache.domainHostname === probeHostname;
  const [domainHealth, setDomainHealth] = useState<DomainHealth>(
    // Seed from cache on a tab return; otherwise start at 'checking' when a
    // probe is about to run (effects fire after the first paint, so a
    // 'not_set_up' seed would flash "Not set up"/"Set up" for a real domain
    // before the probe begins). 'not_set_up' stays only for the genuine
    // localhost/no-domain case, where no probe runs.
    cacheMatchesHost ? (overviewStateCache.domainHealth ?? 'not_set_up') : probeHostname ? 'checking' : 'not_set_up',
  );

  const checkDomain = async (hostname: string, isCancelled: () => boolean = () => false, silent = false) => {
    // On a tab-return remount we already have a cached verdict; re-validate
    // silently so the checklist does not flash back to "checking"/incomplete.
    if (!silent) setDomainHealth('checking');
    let next: DomainHealth;
    try {
      const res = await fetch(`/api/public-health?domain=${encodeURIComponent(hostname)}`, { cache: 'no-store' });
      const data = await res.json();
      next = data.ok ? 'reachable' : 'unreachable';
    } catch {
      next = 'unreachable';
    }
    // A response that lands after the effect re-ran (domain changed) or the
    // component unmounted must not write a stale verdict.
    if (!isCancelled()) {
      setDomainHealth(next);
      overviewStateCache.domainHostname = hostname;
      overviewStateCache.domainHealth = next;
    }
  };

  useEffect(() => {
    if (!probeHostname) {
      setDomainHealth('not_set_up');
      overviewStateCache.domainHostname = null;
      overviewStateCache.domainHealth = 'not_set_up';
      return;
    }
    let cancelled = false;
    // Silence the probe (no "checking" flash) only when the cached verdict is
    // for THIS hostname and was reachable.
    const silent =
      overviewStateCache.domainHostname === probeHostname && overviewStateCache.domainHealth === 'reachable';
    void checkDomain(probeHostname, () => cancelled, silent);
    return () => {
      cancelled = true;
    };
  }, [probeHostname]);

  // PKARR record verification: does the record on the Pubky DHT/relays match
  // what this homeserver is configured to publish? One auto-check when the
  // pubkey and expectations are known (same no-polling rule as the domain
  // probe), manual re-check, verdict + parsed record cached across tab
  // switches with silent revalidation.
  const pkarrPubkey = info?.public_key ?? info?.pubkey ?? null;
  // Current homeservers report "ip:port"; some older ones reported a
  // pubky:// URI, which is an identifier, not an address expectation.
  const rawPkarrAddress = info?.pkarr_pubky_address?.trim() || null;
  const pkarrExpectedAddress = rawPkarrAddress && !rawPkarrAddress.includes('/') ? rawPkarrAddress : null;
  // The localhost default means "never set up": expect no domain then.
  const pkarrExpectedDomain = domainHostname(info?.pkarr_icann_domain) ? (info?.pkarr_icann_domain ?? null) : null;
  const pkarrKey = pkarrPubkey ? `${pkarrPubkey}|${pkarrExpectedAddress ?? ''}|${pkarrExpectedDomain ?? ''}` : null;
  const pkarrCacheMatches = pkarrKey !== null && overviewStateCache.pkarrKey === pkarrKey;
  const [pkarrHealth, setPkarrHealth] = useState<PkarrHealth>(
    pkarrCacheMatches ? (overviewStateCache.pkarrHealth ?? 'unknown') : 'unknown',
  );
  const [pkarrResult, setPkarrResult] = useState<PkarrHealthResponse | null>(
    pkarrCacheMatches ? (overviewStateCache.pkarrResult ?? null) : null,
  );
  // Which pkarrKey the two states above belong to. When `info` changes the
  // pubkey/expectations WHILE mounted (a live refetch, not a remount), the
  // useState seeds do not re-run, so the old verdict and old record object
  // linger in state until the effect's async check resolves. Tracking the
  // owning key lets the render discard a stale result instead of showing one
  // pubkey's record (and pkdns link) under another's.
  const [pkarrStateKey, setPkarrStateKey] = useState<string | null>(pkarrCacheMatches ? pkarrKey : null);
  const [pkarrViewerOpen, setPkarrViewerOpen] = useState(false);

  const checkPkarr = async (isCancelled: () => boolean = () => false, silent = false) => {
    if (!pkarrKey || !pkarrPubkey) return;
    if (!silent) setPkarrHealth('checking');
    let health: PkarrHealth;
    let result: PkarrHealthResponse | null = null;
    try {
      const params = new URLSearchParams({ pubkey: pkarrPubkey });
      if (pkarrExpectedAddress) params.set('expected_address', pkarrExpectedAddress);
      if (pkarrExpectedDomain) params.set('expected_domain', pkarrExpectedDomain);
      const res = await fetch(`/api/pkarr-health?${params.toString()}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`pkarr-health ${res.status}`);
      const data = (await res.json()) as Partial<PkarrHealthResponse>;
      // Anything that is not a well-formed verdict payload (a proxy error
      // page, a stale mock, an old server) proves nothing about the record.
      const verdicts: PkarrHealth[] = ['verified', 'mismatch', 'not_found', 'invalid', 'unavailable'];
      if (!data.verdict || !verdicts.includes(data.verdict) || !Array.isArray(data.records)) {
        throw new Error('malformed pkarr-health response');
      }
      result = data as PkarrHealthResponse;
      health = result.verdict;
    } catch {
      // A failed probe says nothing about the record - same bucket as
      // "relays unreachable".
      health = 'unavailable';
    }
    if (!isCancelled()) {
      setPkarrHealth(health);
      setPkarrResult(result);
      setPkarrStateKey(pkarrKey);
      overviewStateCache.pkarrKey = pkarrKey;
      overviewStateCache.pkarrHealth = health;
      overviewStateCache.pkarrResult = result;
    }
  };

  useEffect(() => {
    if (!pkarrKey) {
      setPkarrHealth('unknown');
      setPkarrResult(null);
      setPkarrStateKey(null);
      overviewStateCache.pkarrKey = null;
      overviewStateCache.pkarrHealth = 'unknown';
      overviewStateCache.pkarrResult = null;
      return;
    }
    // A key change means a different record: close any open viewer so it
    // cannot linger showing the previous pubkey's record.
    setPkarrViewerOpen(false);
    let cancelled = false;
    // Any settled cached verdict for THIS key revalidates silently - a tab
    // return must not flash "Checking…" over a known verdict.
    const cached = overviewStateCache.pkarrKey === pkarrKey ? overviewStateCache.pkarrHealth : undefined;
    const silent = cached !== undefined && cached !== 'unknown' && cached !== 'checking';
    void checkPkarr(() => cancelled, silent);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pkarrKey derives the other inputs
  }, [pkarrKey]);

  // Durable restart-pending signal (boot stamp vs state mtimes, server
  // derived): survives page reloads, unlike the Settings dialog's session
  // state. Reachability cannot stand in for it - the tunnel reconnects
  // without a restart, the pkarr publication does not. The same read carries
  // the server-derived Cloudflare mode, which drives the get-started step.
  const [restartPending, setRestartPending] = useState(overviewStateCache.restartPending ?? false);
  const [cloudflareMode, setCloudflareMode] = useState<string | null>(overviewStateCache.cloudflareMode ?? null);
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch('/api/cloudflare-config', { cache: 'no-store' });
        const data = await res.json();
        if (!cancelled) {
          const pending = data.restart_pending === true;
          const mode = typeof data.mode === 'string' ? data.mode : null;
          setRestartPending(pending);
          setCloudflareMode(mode);
          overviewStateCache.restartPending = pending;
          overviewStateCache.cloudflareMode = mode;
        }
      } catch {
        // unknown: keep the callout hidden
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [cloudflareRefreshKey]);

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="space-y-3">
          {[...Array(3)].map((_, i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-4 w-56" />
            </div>
          ))}
        </CardContent>
      </Card>
    );
  }

  // Only show server details if we have info
  if (!info) {
    return (
      <Card>
        <CardHeader className="pb-4">
          <div className="flex items-center justify-between">
            <div className="min-w-0 flex-1">
              <CardTitle className="flex items-center gap-2 text-base sm:text-lg">Server & Connection</CardTitle>
              <CardDescription className="text-xs sm:text-sm">
                Homeserver details and dashboard connection
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        {/* Inset separator between the header and the content (lighter than a full divider) */}
        <div className="mx-6 h-px bg-border/60" />

        <CardContent className="space-y-3 pt-4">
          {/* Connection Status */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="shrink-0 text-xs text-muted-foreground sm:text-sm">Connection Status:</span>
            <div className="shrink-0">
              <Badge variant="destructive" className="text-xs">
                <AlertCircle className="mr-1 h-3 w-3" />
                Not Connected
              </Badge>
            </div>
          </div>
          {connectionError && <ConnectionErrorAlert message={connectionError} onRetry={onRetry} />}
        </CardContent>
      </Card>
    );
  }

  // homeserverPubkey is the same new-or-legacy field already resolved as
  // pkarrPubkey above; reuse it (no fallback - a made-up pubkey gets copied
  // into pkdns and shared).
  const homeserverPubkey = pkarrPubkey;
  const homeserverVersion = info.version ?? null;

  // Render the pkarr verdict/record only when the state actually belongs to
  // the current key. On an in-place key change the stale state lingers for a
  // render before the effect refreshes it; treat that as "checking" with no
  // result so the chip never shows another pubkey's verdict and the viewer
  // (gated on shownPkarrResult below) unmounts rather than showing a record
  // under the wrong pkdns link.
  const pkarrStateFresh = pkarrStateKey === pkarrKey;
  const shownPkarrHealth: PkarrHealth = pkarrStateFresh ? pkarrHealth : 'checking';
  const shownPkarrResult = pkarrStateFresh ? pkarrResult : null;

  // The published address is a throwaway Preview tunnel when it is a
  // *.trycloudflare.com Quick Tunnel, or when the dashboard's own mode says
  // preview. Either signal flags the row so the operator knows its limits.
  const isPreviewAddress = (probeHostname?.endsWith('.trycloudflare.com') ?? false) || cloudflareMode === 'preview';

  return (
    <div className="space-y-4">
      {/* Get-started checklist: rendered only when its wiring is present
          (onDismissSetupGuide) and the user has not dismissed it. */}
      {onDismissSetupGuide && setupGuideDismissed === false && (
        <GetStartedChecklist
          // 'done' once the mode is active and the probe answered; 'checking'
          // while the Cloudflare mode or the probe is still loading (so the
          // step shows a spinner, not a premature "Set up access"); otherwise
          // 'todo'.
          reachableStatus={
            cloudflareMode !== null && cloudflareMode !== 'off' && domainHealth === 'reachable'
              ? 'done'
              : cloudflareMode === null || domainHealth === 'checking'
                ? 'checking'
                : 'todo'
          }
          inviteDone={info.num_signup_codes > 0}
          signupDone={info.num_users > 0}
          showReachableStep={platform === 'umbrel'}
          onSetUpAccess={onFixCloudflare}
          onCreateInvite={onGoToInvites}
          onDismiss={onDismissSetupGuide}
        />
      )}
      <div className="grid gap-4">
        <Card>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <CardTitle className="flex items-center gap-2 text-base sm:text-lg">Server & Connection</CardTitle>
                <CardDescription className="text-xs sm:text-sm">
                  Homeserver details and dashboard connection
                </CardDescription>
              </div>
            </div>
          </CardHeader>

          {/* Inset separator between the header and the content (lighter than a full divider) */}
          <div className="mx-6 h-px bg-border/60" />

          <CardContent className="space-y-3 pt-4">
            {/* Connection Status */}
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="shrink-0 text-xs text-muted-foreground sm:text-sm">Connection Status:</span>
              <div className="shrink-0">
                {isConnected ? (
                  <div className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand sm:text-sm">
                    <CircleCheckBig className="h-4 w-4" />
                    <span>Connected</span>
                  </div>
                ) : (
                  <Badge variant="destructive" className="text-xs">
                    <AlertCircle className="mr-1 h-3 w-3" />
                    Not Connected
                  </Badge>
                )}
              </div>
            </div>

            {/* Connection Error Message */}
            {connectionError && <ConnectionErrorAlert message={connectionError} onRetry={onRetry} />}

            {/* After a failed refetch the details below are from the last
                successful read, not the present: say so and dim them. */}
            {!isConnected && (
              <p className="pt-1 text-xs font-medium text-muted-foreground" data-testid="stale-info-label">
                Last known state
              </p>
            )}

            <div className={cn('space-y-3', !isConnected && 'opacity-70')}>
              {/* Server Pubkey */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className="shrink-0 text-xs text-muted-foreground sm:text-sm">Homeserver Pubkey:</span>
                {homeserverPubkey ? (
                  <div className="flex min-w-0 flex-1 flex-col items-start gap-1 sm:flex-initial sm:items-end">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="font-mono text-xs break-all text-foreground sm:text-sm">{homeserverPubkey}</span>
                      <CopyValueButton value={homeserverPubkey} label="Copy pubkey" />
                    </div>
                    <a
                      href={`https://pkdns.net/?id=${encodeURIComponent(homeserverPubkey)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground hover:underline"
                      title="Open pkdns.net to see the PKARR record published for this homeserver on the Pubky DHT (its address, domain, and port)"
                      data-testid="pkdns-verify-link"
                    >
                      <ExternalLink className="h-3 w-3" />
                      Verify on the DHT
                    </a>
                  </div>
                ) : (
                  <NotAvailable />
                )}
              </div>

              {/* Server Version */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className="shrink-0 text-xs text-muted-foreground sm:text-sm">Homeserver version:</span>
                {homeserverVersion ? (
                  <span className="text-xs break-words text-foreground sm:text-sm">{homeserverVersion}</span>
                ) : (
                  <NotAvailable />
                )}
              </div>

              {/* Pubky address (technically the PKARR address) */}
              {info.pkarr_pubky_address && (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="shrink-0 text-xs text-muted-foreground sm:text-sm" title="PKARR address">
                      Pubky address:
                    </span>
                    <span className="text-xs text-muted-foreground/70">How Pubky apps find this server</span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <code className="min-w-0 rounded bg-muted px-2 py-1 font-mono text-xs break-all">
                      {info.pkarr_pubky_address}
                    </code>
                    <CopyValueButton value={info.pkarr_pubky_address} label="Copy address" />
                    <AddressScopeBadge address={info.pkarr_pubky_address} />
                  </div>
                </div>
              )}

              {/* Public domain (technically the PKARR ICANN domain) + live
                  reachability. Always rendered: a missing or localhost value
                  means public access was never set up, which is exactly what
                  the row should say (without leaking the localhost value). */}
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className="shrink-0 text-xs text-muted-foreground sm:text-sm" title="PKARR ICANN domain">
                  Public address:
                </span>
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  {probeHostname && info.pkarr_icann_domain && (
                    <>
                      {/* The homeserver reports the domain with its publish port
                          (e.g. host:443); render an openable link (drop :443,
                          infer https) and copy that working URL, so a pasted
                          address actually opens instead of failing on host:443. */}
                      <a
                        href={publicAddressLink(info.pkarr_icann_domain).href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="min-w-0 rounded bg-muted px-2 py-1 font-mono text-xs break-all text-foreground underline-offset-2 hover:underline"
                        data-testid="public-address-link"
                      >
                        {publicAddressLink(info.pkarr_icann_domain).label}
                      </a>
                      <CopyValueButton
                        value={publicAddressLink(info.pkarr_icann_domain).href}
                        label="Copy public address"
                      />
                      {isPreviewAddress && (
                        <PreviewModeBadge onSetUpCloudflare={platform === 'umbrel' ? onFixCloudflare : undefined} />
                      )}
                    </>
                  )}
                  {domainHealth === 'checking' && (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                      data-testid="domain-health-checking"
                    >
                      <RefreshCw className="h-3 w-3 animate-spin" /> Checking…
                    </span>
                  )}
                  {domainHealth === 'reachable' && (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand"
                      data-testid="domain-health-reachable"
                    >
                      <CircleCheckBig className="h-3 w-3" /> Reachable
                    </span>
                  )}
                  {domainHealth === 'unreachable' && (
                    <span
                      className="inline-flex shrink-0 items-center gap-1 text-xs text-amber-400"
                      data-testid="domain-health-unreachable"
                    >
                      <AlertCircle className="h-3 w-3" /> {restartPending ? 'Not reachable yet' : 'Not reachable'}
                    </span>
                  )}
                  {domainHealth === 'not_set_up' && (
                    <span className="shrink-0 text-xs text-muted-foreground" data-testid="domain-health-not-set-up">
                      Not set up
                    </span>
                  )}
                  {probeHostname && domainHealth !== 'checking' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 shrink-0 px-1.5"
                      onClick={() => void checkDomain(probeHostname)}
                      aria-label="Re-check public address reachability"
                      data-testid="domain-health-recheck"
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                  )}
                  {/* Right after a setup the domain is expectedly unreachable
                      until the app restarts; "Fix it" would point at a
                      non-problem. */}
                  {((domainHealth === 'unreachable' && !restartPending) || domainHealth === 'not_set_up') &&
                    platform === 'umbrel' &&
                    onFixCloudflare && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-xs"
                        onClick={onFixCloudflare}
                        data-testid="domain-health-fix"
                      >
                        {domainHealth === 'not_set_up' ? 'Set up' : 'Fix it'}
                      </Button>
                    )}
                  {domainHealth === 'unreachable' && restartPending && (
                    <span className="w-full text-xs text-muted-foreground" data-testid="domain-health-restart-hint">
                      To finish setup: {restartSentence}
                    </span>
                  )}
                </div>
              </div>

              {/* PKARR record verification: is the record on the Pubky
                  DHT/relays signed by this key and advertising the configured
                  address? Rendered only when the pubkey is known. */}
              {pkarrPubkey && (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="shrink-0 text-xs text-muted-foreground sm:text-sm">Pubky network:</span>
                    <span className="text-xs text-muted-foreground/70">The record published to the DHT</span>
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    {shownPkarrHealth === 'checking' && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
                        data-testid="pkarr-health-checking"
                      >
                        <RefreshCw className="h-3 w-3 animate-spin" /> Checking…
                      </span>
                    )}
                    {shownPkarrHealth === 'verified' && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-brand"
                        data-testid="pkarr-health-verified"
                        title="A record signed by this homeserver's key exists on the Pubky relays and matches its configuration."
                      >
                        <CircleCheckBig className="h-3 w-3" /> Published
                      </span>
                    )}
                    {shownPkarrHealth === 'mismatch' && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 text-xs text-amber-400"
                        data-testid="pkarr-health-mismatch"
                        title="The published record does not match this homeserver's configured address or domain. Open View for the comparison."
                      >
                        <AlertCircle className="h-3 w-3" /> Doesn&apos;t match config
                      </span>
                    )}
                    {shownPkarrHealth === 'invalid' && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 text-xs text-amber-400"
                        data-testid="pkarr-health-invalid"
                        title="The record found on the relays failed signature verification."
                      >
                        <AlertCircle className="h-3 w-3" /> Invalid record
                      </span>
                    )}
                    {shownPkarrHealth === 'not_found' && (
                      <span
                        className="inline-flex shrink-0 items-center gap-1 text-xs text-amber-400"
                        data-testid="pkarr-health-not-found"
                        title="No record was found on the Pubky relays for this homeserver's key, so Pubky apps cannot discover this server."
                      >
                        <AlertCircle className="h-3 w-3" /> Not published
                      </span>
                    )}
                    {shownPkarrHealth === 'unavailable' && (
                      <span
                        className="shrink-0 text-xs text-muted-foreground"
                        data-testid="pkarr-health-unavailable"
                        title="The Pubky relays could not be reached from here - nothing is known about the record right now. This does not mean anything is wrong with your server."
                      >
                        Can&apos;t verify right now
                      </span>
                    )}
                    {shownPkarrHealth !== 'checking' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 shrink-0 px-1.5"
                        onClick={() => void checkPkarr()}
                        aria-label="Re-check the published PKARR record"
                        data-testid="pkarr-health-recheck"
                      >
                        <RefreshCw className="h-3 w-3" />
                      </Button>
                    )}
                    {shownPkarrResult && shownPkarrResult.records.length > 0 && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 shrink-0 px-2 text-xs"
                        onClick={() => setPkarrViewerOpen(true)}
                        data-testid="pkarr-view-record"
                      >
                        View
                      </Button>
                    )}
                    {/* Right after a setup change the old record is expected
                        on the relays until the app restarts and republishes. */}
                    {(shownPkarrHealth === 'mismatch' || shownPkarrHealth === 'not_found') && restartPending && (
                      <span className="w-full text-xs text-muted-foreground" data-testid="pkarr-health-restart-hint">
                        The record updates when the app restarts.
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Durable restart signal next to the reachability/"Fix it" area */}
            {restartPending && <RestartCallout />}
          </CardContent>
        </Card>
      </div>

      {pkarrPubkey && shownPkarrResult && (
        <PkarrRecordViewer
          open={pkarrViewerOpen}
          onOpenChange={setPkarrViewerOpen}
          result={shownPkarrResult}
          pubkey={pkarrPubkey}
        />
      )}

      {/* Where the data actually lives; the dashboard offers no export, so
          this is the one place the backup story is told. The umbrelOS backup
          guidance only applies on Umbrel. */}
      <p className="px-1 text-xs text-muted-foreground/70" data-testid="backup-note">
        {platform === 'umbrel' ? (
          <>
            Backups: your homeserver&apos;s identity and all user data live in this app&apos;s data directory, and
            umbrelOS 1.5+ built-in backups include app data automatically. Just don&apos;t exclude this app in your
            backup settings; losing this data means losing this server&apos;s identity.
          </>
        ) : (
          <>
            Backups: your homeserver&apos;s identity and all user data live in this app&apos;s data directory. Back it
            up regularly — losing this data means losing this server&apos;s identity.
          </>
        )}
      </p>
    </div>
  );
}
