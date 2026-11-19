'use client';

import { useState, useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { RefreshCw, CheckCircle, AlertCircle, Eye, EyeOff, Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAdminInfo } from '@/hooks/admin';
import { useCopyFeedback } from '@/hooks/useCopyFeedback';
import { CloudflareAutoSetup } from './CloudflareAutoSetup';
import { CloudflareConnect } from './CloudflareConnect';
import { CloudflarePreview } from './CloudflarePreview';
import { RestartCallout } from './RestartCallout';
import { useRestartSentence } from '@/hooks/useRestartSentence';
import { usePlatform } from '@/components/providers/PlatformProvider';
import { publicAddressLink } from '@/lib/public-address';

type Tab = 'config' | 'cloudflare';
type CloudflareMode = 'connect' | 'token' | 'preview' | 'off';
type RestartReason = 'setup_changed' | 'preview_changed' | 'config_changed';
type CloudflareConfig = {
  domain: string | null;
  mode: CloudflareMode;
  configured: boolean;
  supported: boolean;
  /** Server-derived (boot stamp vs state mtimes); null = unknown (no stamp). */
  restart_pending?: boolean | null;
  restart_reason?: RestartReason | null;
};
type HealthStatus = 'idle' | 'checking' | 'ok' | 'fail';

const MODE_LABELS: Record<CloudflareMode, string> = {
  connect: 'Connected account',
  token: 'API token',
  preview: 'Preview',
  off: 'Off',
};

/** A chevron + label button that toggles a collapsible setup section. */
function DisclosureToggle({
  open,
  onToggle,
  label,
  testId,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
      onClick={onToggle}
      data-testid={testId}
    >
      {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      {label}
    </button>
  );
}

interface ConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Drives whether the Config tab exposes an Edit button. Comes from /api/capabilities. */
  writable?: boolean;
  /** Increment to force the dialog onto the Cloudflare tab (Overview "Fix it"). */
  focusCloudflare?: number;
}

type SaveMessage = { type: 'success' | 'error' | 'conflict'; text: string };

export function ConfigDialog({ open, onOpenChange, writable = false, focusCloudflare = 0 }: ConfigDialogProps) {
  const restartSentence = useRestartSentence();
  // Cloudflare setup runs as separate Umbrel containers; it cannot work
  // standalone, so the whole tab is hidden there.
  const platform = usePlatform();
  const [activeTab, setActiveTab] = useState<Tab>(platform === 'umbrel' ? 'cloudflare' : 'config');
  const [isConfigTabVisible, setIsConfigTabVisible] = useState(false);

  // The Overview "Fix it" button bumps this nonce; jump to the Cloudflare
  // tab even if a previous open left the dialog on Config.
  useEffect(() => {
    if (focusCloudflare > 0) setActiveTab('cloudflare');
  }, [focusCloudflare]);

  // Config file state
  const [configValue, setConfigValue] = useState('');
  const [configChecksum, setConfigChecksum] = useState<string | null>(null);
  const [configMtime, setConfigMtime] = useState<string | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [isReloading, setIsReloading] = useState(false);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<SaveMessage | null>(null);

  // Admin password reveal state. Fetched lazily on first reveal, never on mount.
  const [adminPassword, setAdminPassword] = useState<string | null>(null);
  const [isAdminPasswordVisible, setIsAdminPasswordVisible] = useState(false);
  const [adminPasswordError, setAdminPasswordError] = useState<string | null>(null);
  const {
    copiedKey: adminPasswordCopiedKey,
    copy: copyAdminPassword,
    reset: resetAdminPasswordCopied,
  } = useCopyFeedback();

  const ensureAdminPassword = async (): Promise<string | null> => {
    if (adminPassword) return adminPassword;
    try {
      const res = await fetch('/api/admin-password', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to fetch admin password');
      setAdminPassword(data.password);
      setAdminPasswordError(null);
      return data.password;
    } catch (err) {
      setAdminPasswordError(err instanceof Error ? err.message : 'Failed to fetch admin password');
      return null;
    }
  };

  const handleToggleAdminPassword = async () => {
    if (isAdminPasswordVisible) {
      setIsAdminPasswordVisible(false);
      return;
    }
    const password = await ensureAdminPassword();
    if (password) setIsAdminPasswordVisible(true);
  };

  const handleCopyAdminPassword = async () => {
    const password = await ensureAdminPassword();
    if (!password) return;
    // A copy failure (clipboard unavailable) is silent; the eye toggle still works.
    await copyAdminPassword(password);
  };

  // Re-mask the password whenever the dialog closes.
  useEffect(() => {
    if (!open) {
      setIsAdminPasswordVisible(false);
      resetAdminPasswordCopied();
    }
  }, [open, resetAdminPasswordCopied]);

  // Cloudflare state. The mode comes from the server (file fingerprints);
  // the Status surface is the only place that asserts it. Setup cards are
  // pure actions keyed by setupNonce so a disconnect remounts them and none
  // can carry a stale "completed" state.
  const [isCloudflareTabVisible, setIsCloudflareTabVisible] = useState(false);
  const [cfConfig, setCfConfig] = useState<CloudflareConfig | null>(null);
  const [cfError, setCfError] = useState<string | null>(null);
  const [cfLoading, setCfLoading] = useState(true);
  const [cfSaving, setCfSaving] = useState(false);
  const [cfDomain, setCfDomain] = useState('');
  const [cfToken, setCfToken] = useState('');
  const [cfMessage, setCfMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [healthStatus, setHealthStatus] = useState<HealthStatus>('idle');
  const [healthError, setHealthError] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnectMessage, setDisconnectMessage] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showSetupMethods, setShowSetupMethods] = useState(false);
  const [setupNonce, setSetupNonce] = useState(0);
  // Which flow just completed in this session; drives the restart callout on
  // the Status surface until the next dialog open. recentMessage carries the
  // completing route's own message (e.g. the re-setup-over-a-live-tunnel
  // warning) so the callout never claims more than the route did.
  const [recentChange, setRecentChange] = useState<'connect' | 'token' | null>(null);
  const [recentMessage, setRecentMessage] = useState<string | null>(null);
  // Publication truth: the running homeserver's /info reports the domain its
  // pkarr record actually advertises. Separate from HTTPS reachability - the
  // tunnel reconnects without a restart, the pkarr record does not.
  const { data: adminInfo, refetch: refetchAdminInfo } = useAdminInfo();

  // The post-setup health probe chain re-arms itself via setTimeout for up to
  // ~37s; track the pending timer so closing the dialog or unmounting stops
  // the chain instead of leaving it probing (and setting state) in the dark.
  const probeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearProbeTimer = () => {
    if (probeTimerRef.current) {
      clearTimeout(probeTimerRef.current);
      probeTimerRef.current = null;
    }
  };
  useEffect(() => clearProbeTimer, []);
  useEffect(() => {
    if (!open) clearProbeTimer();
  }, [open]);

  const checkHealth = async (domain: string): Promise<boolean> => {
    setHealthStatus('checking');
    setHealthError(null);
    try {
      const res = await fetch(`/api/public-health?domain=${encodeURIComponent(domain)}`);
      const data = await res.json();
      if (data.ok) {
        setHealthStatus('ok');
        return true;
      }
      setHealthStatus('fail');
      // 530 is Cloudflare's "origin unreachable" (error 1033: tunnel has no
      // connector). Raw status codes mean nothing to the operator; name the
      // actual condition and the way out.
      const upstreamStatus = data.status ?? res.status;
      setHealthError(
        upstreamStatus === 530 || upstreamStatus === 1033
          ? `Tunnel not connected. If you just set this up, give it a moment. ${restartSentence}`
          : data.error || `HTTP ${upstreamStatus}`,
      );
      return false;
    } catch {
      setHealthStatus('fail');
      setHealthError('Request failed');
      return false;
    }
  };

  const fetchCloudflareConfig = async (): Promise<CloudflareConfig | null> => {
    setCfError(null);
    try {
      const res = await fetch('/api/cloudflare-config', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setCfConfig(data);
      setIsCloudflareTabVisible(platform === 'umbrel' && Boolean(data.supported));
      if (data.domain) setCfDomain(data.domain);
      return data;
    } catch (err) {
      // A failed read means "temporarily unavailable", not "unsupported":
      // keep the tab and offer a retry instead of hiding the whole surface
      // (but never on standalone, where the tab does not apply at all).
      setCfError(err instanceof Error ? err.message : 'Request failed');
      setIsCloudflareTabVisible(platform === 'umbrel');
      return null;
    }
  };

  const loadCloudflare = async () => {
    setCfLoading(true);
    const data = await fetchCloudflareConfig();
    setCfLoading(false);
    // One automatic reachability probe per load of an active domain setup;
    // its failure drives the consolidated restart callout below the badge.
    if (data?.domain && (data.mode === 'connect' || data.mode === 'token')) {
      void checkHealth(data.domain);
    }
  };

  const handleDisconnectAll = async () => {
    if (!confirmDisconnect) {
      setConfirmDisconnect(true);
      return;
    }
    setConfirmDisconnect(false);
    try {
      const res = await fetch('/api/cloudflare-disconnect', { method: 'POST' });
      const data = await res.json().catch(() => ({}) as Record<string, never>);
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setCfDomain('');
      setCfToken('');
      setHealthStatus('idle');
      setRecentChange(null);
      setRecentMessage(null);
      setDisconnectMessage(data.message || `Disconnected. ${restartSentence}`);
      // Re-read the server-derived mode and remount the setup cards so the
      // whole tab re-syncs from the single source of truth.
      await fetchCloudflareConfig();
      setSetupNonce((n) => n + 1);
      setShowSetupMethods(false);
    } catch (err) {
      setCfMessage({ type: 'error', text: err instanceof Error ? err.message : 'Disconnect failed' });
    }
  };

  const fetchConfig = async () => {
    setConfigError(null);
    try {
      const res = await fetch('/api/server-config', { cache: 'no-store' });
      const data = await res.json();
      if (!res.ok) {
        // Hide config tab if the file is missing/unavailable in this environment.
        if (res.status === 404) {
          setIsConfigTabVisible(false);
        }
        setConfigError(data.error || `HTTP ${res.status}`);
        setConfigValue('');
        setConfigChecksum(null);
        setConfigMtime(null);
      } else {
        setIsConfigTabVisible(true);
        setConfigValue(data.config || '');
        setEditValue(data.config || '');
        setConfigChecksum(data.checksum ?? null);
        setConfigMtime(data.mtime ?? null);
      }
    } catch {
      setConfigError('Failed to load config');
      setConfigValue('');
      setConfigChecksum(null);
      setConfigMtime(null);
    }
  };

  const handleReload = async () => {
    setIsReloading(true);
    await fetchConfig();
    setIsReloading(false);
  };

  const handleStartEdit = () => {
    setIsEditing(true);
    setSaveMessage(null);
    setEditValue(configValue);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setSaveMessage(null);
    setEditValue(configValue);
  };

  const handleSave = async () => {
    if (!configChecksum) return;
    setIsSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch('/api/server-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config_toml: editValue, checksum: configChecksum }),
      });
      const data = await res.json();
      if (res.status === 409) {
        setSaveMessage({
          type: 'conflict',
          text:
            data.error ||
            'Config has been modified by someone else. Reload to see the latest, or save again to overwrite.',
        });
        // Pull the new checksum so a re-save can be a "force save" (one more click)
        if (data.current_checksum) setConfigChecksum(data.current_checksum);
        return;
      }
      if (!res.ok) {
        setSaveMessage({ type: 'error', text: data.error || `Save failed (${res.status})` });
        return;
      }
      // Success: refresh and exit edit mode
      setConfigValue(editValue);
      setConfigChecksum(data.checksum ?? null);
      setConfigMtime(data.updated_at ?? null);
      setIsEditing(false);
      setSaveMessage({
        type: 'success',
        text: data.message || `Config saved. ${restartSentence}`,
      });
    } catch {
      setSaveMessage({ type: 'error', text: 'Request failed' });
    } finally {
      setIsSaving(false);
    }
  };

  const isDirty = isEditing && editValue !== configValue;

  // Fetch server config when dialog opens
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setConfigLoading(true);
    fetchConfig().finally(() => {
      if (!cancelled) setConfigLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Ensure we never stay on hidden tabs. Visibility starts as false because
  // it is UNKNOWN until the availability fetch lands, so each bounce must
  // wait for its own tab's fetch: otherwise opening on the Cloudflare tab
  // (the default, and the Overview "Fix it" target) races the two fetches
  // and lands on Config whenever server-config resolves first.
  useEffect(() => {
    if (activeTab === 'config' && !configLoading && !isConfigTabVisible) {
      if (isCloudflareTabVisible) setActiveTab('cloudflare');
      return;
    }
    if (activeTab === 'cloudflare' && !cfLoading && !isCloudflareTabVisible) {
      if (isConfigTabVisible) setActiveTab('config');
    }
  }, [activeTab, isConfigTabVisible, isCloudflareTabVisible, configLoading, cfLoading]);

  // Fetch Cloudflare config when the dialog opens; per-open feedback state
  // (callouts, confirm arming, probe results) resets so the Status surface
  // always reflects a fresh server read.
  useEffect(() => {
    if (!open) return;
    setDisconnectMessage(null);
    setRecentChange(null);
    setRecentMessage(null);
    setHealthStatus('idle');
    setConfirmDisconnect(false);
    setCfMessage(null);
    setShowSetupMethods(false);
    void loadCloudflare();
    // Fresh publication truth: the app may have been restarted since mount.
    void refetchAdminInfo();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // The Status surface shows the preview address; poll until the tunnel has
  // handed one out (the instant tunnel needs a few seconds after enable).
  useEffect(() => {
    if (!open || cfConfig?.mode !== 'preview') {
      setPreviewUrl(null);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const res = await fetch('/api/cloudflare-preview', { cache: 'no-store' });
        const data = await res.json();
        if (cancelled) return;
        const url: string | null = data.instant?.url ?? data.published_url ?? null;
        setPreviewUrl(url);
        if (!url) timer = setTimeout(() => void load(), 3000);
      } catch {
        if (!cancelled) timer = setTimeout(() => void load(), 3000);
      }
    };
    void load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, cfConfig?.mode]);

  // Four setup tiers live together: Connect (primary), API token and Manual
  // are collapsed escape hatches, Test drive sits apart as a no-account
  // preview. Collapsed-by-default keeps the tab scannable.
  const [showManualSetup, setShowManualSetup] = useState(false);
  const [showApiTokenSetup, setShowApiTokenSetup] = useState(false);

  const handleAutoConfigured = (hostname: string, source: 'connect' | 'token', message?: string) => {
    setCfDomain(hostname);
    setDisconnectMessage(null);
    setRecentChange(source);
    setRecentMessage(message ?? null);
    // Keep the just-completed card's feedback visible even though the cards
    // now sit behind the "Switch setup method" disclosure.
    setShowSetupMethods(true);
    void fetchCloudflareConfig();
    // Both flows' tunnels connect WITHOUT an app restart: the crash-looping
    // cloudflared containers pick up the new token/config within a minute
    // (the restart only publishes the domain to the Pubky network). Edge DNS
    // plus the first connection can still take a while, so probe up to 4
    // times before surfacing a failure: the user must not be flashed a red
    // "Not reachable" right after the green success state.
    setHealthStatus('checking');
    const probeHealth = async (attempt: number) => {
      probeTimerRef.current = null;
      const reachable = await checkHealth(hostname);
      if (!reachable && attempt < 4) {
        setHealthStatus('checking');
        probeTimerRef.current = setTimeout(() => void probeHealth(attempt + 1), 8_000);
      }
    };
    clearProbeTimer();
    probeTimerRef.current = setTimeout(() => void probeHealth(1), 5_000);
  };

  const handlePreviewEnabled = () => {
    setDisconnectMessage(null);
    setShowSetupMethods(true);
    void fetchCloudflareConfig();
  };

  const handleCfSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setCfMessage(null);
    setCfSaving(true);
    try {
      const res = await fetch('/api/cloudflare-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: cfDomain.trim() || undefined, token: cfToken || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setCfMessage({ type: 'error', text: data.error || 'Failed to save' });
        return;
      }
      setCfMessage({
        type: 'success',
        text:
          data.message ||
          `Saved. The tunnel picks this up within a minute. ${restartSentence} The restart publishes your public address to the Pubky network.`,
      });
      setHealthStatus('idle'); // Reset health check after save
      const fresh = await fetchCloudflareConfig();
      if (fresh?.mode === 'token') {
        setRecentChange('token');
        setRecentMessage(typeof data.message === 'string' ? data.message : null);
        setShowSetupMethods(true);
      }
    } catch {
      setCfMessage({ type: 'error', text: 'Request failed' });
    } finally {
      setCfSaving(false);
    }
  };

  // Cloudflare first: it is the dialog's default tab and the Overview's
  // "Fix it"/"Set up" target, so the rail order matches where users land.
  const tabs: { id: Tab; label: string }[] = [
    ...(isCloudflareTabVisible ? [{ id: 'cloudflare' as Tab, label: 'Cloudflare' }] : []),
    ...(isConfigTabVisible ? [{ id: 'config' as Tab, label: 'Config' }] : []),
  ];

  const cfMode: CloudflareMode = cfConfig?.mode ?? 'off';
  // Server-derived restart signal; null means unknown (no boot stamp), in
  // which case the in-session signals below carry today's behavior alone.
  const restartPending = cfConfig?.restart_pending ?? null;
  // Whether the running homeserver actually advertises the configured domain
  // (pkarr publication), from /info. HTTPS reachability cannot answer this:
  // the tunnel picks up changes without a restart, the pkarr record does not.
  const publishedDomain = adminInfo?.pkarr_icann_domain?.split(':')[0].trim().toLowerCase() || null;
  const publishState: 'published' | 'pending' | 'unknown' =
    !adminInfo || !cfConfig?.domain
      ? 'unknown'
      : publishedDomain === cfConfig.domain.trim().toLowerCase()
        ? 'published'
        : 'pending';
  // The Status surface owns the one restart callout for the whole tab.
  const cfStatusCallout = (() => {
    // restart_pending false = the wrapper has demonstrably run since the
    // newest change, so any in-session "restart to finish" message is stale.
    if (restartPending !== false) {
      if (disconnectMessage) return disconnectMessage;
      if (recentChange)
        return (
          recentMessage ??
          `The tunnel connects within a minute. ${restartSentence} The restart publishes your public address to the Pubky network.`
        );
      // Durable signal: survives page reloads, unlike the session state above.
      if (restartPending === true) {
        if (cfConfig?.restart_reason === 'config_changed')
          return `${restartSentence} The restart applies your configuration changes.`;
        if (cfMode === 'connect' || cfMode === 'token')
          return `${restartSentence} The restart publishes your public address to the Pubky network.`;
        return `${restartSentence} The restart applies your changes.`;
      }
    }
    if ((cfMode === 'connect' || cfMode === 'token') && healthStatus === 'fail')
      return `Your public address is not reachable yet. If you just set this up or restarted, give it a minute and use Check. If it stays unreachable: ${restartSentence}`;
    return null;
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[85vh] max-h-[90vh] max-w-[calc(100vw-2rem)] flex-col p-0 sm:h-[90vh] sm:max-w-[min(64rem,calc(100vw-4rem))]">
        <DialogHeader className="border-b border-border/50 px-6 py-4">
          <DialogTitle className="text-base font-semibold sm:text-lg">Settings</DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground sm:text-sm">
            Server configuration and public access
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-1 overflow-hidden">
          {tabs.length > 0 && (
            <nav className="flex w-32 shrink-0 flex-col border-r border-border/50 py-4 pr-2 pl-4">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'relative py-2 text-left text-sm transition-colors',
                    activeTab === tab.id ? 'font-medium text-brand' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {activeTab === tab.id && (
                    <span className="absolute top-1/2 -left-4 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
                  )}
                  {tab.label}
                </button>
              ))}
            </nav>
          )}

          {/* Tab content */}
          <div className="flex flex-1 flex-col overflow-hidden p-6">
            {tabs.length === 0 &&
              (configLoading || cfLoading ? (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                  Loading settings…
                </div>
              ) : (
                <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
                  Settings are not available in this environment.
                </div>
              ))}

            {activeTab === 'config' && isConfigTabVisible && (
              <div className="flex flex-1 flex-col gap-3 overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">config.toml</span>
                    <Badge variant="secondary" className="text-xs" data-testid="config-mode-badge">
                      {writable ? (isEditing ? 'Editing' : 'Editable') : 'Read-only'}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-1">
                    {writable && !isEditing && (
                      <Button
                        size="sm"
                        className="h-7 px-3"
                        onClick={handleStartEdit}
                        disabled={configLoading || !!configError}
                        data-testid="config-edit"
                      >
                        Edit
                      </Button>
                    )}
                    {writable && isEditing && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-3"
                          onClick={handleCancelEdit}
                          disabled={isSaving}
                          data-testid="config-cancel"
                        >
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          className="h-7 px-3"
                          onClick={handleSave}
                          disabled={isSaving || !isDirty}
                          data-testid="config-save"
                        >
                          {isSaving ? 'Saving…' : saveMessage?.type === 'conflict' ? 'Save anyway' : 'Save'}
                        </Button>
                      </>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={handleReload}
                      disabled={isReloading || configLoading || isSaving}
                      data-testid="config-reload"
                      aria-label="Reload"
                    >
                      <RefreshCw className={cn('h-3.5 w-3.5', (isReloading || configLoading) && 'animate-spin')} />
                    </Button>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2 rounded border border-border/60 bg-muted/20 px-3 py-2">
                  <span className="text-sm font-medium">Admin password</span>
                  <code className="font-mono text-xs text-muted-foreground" data-testid="admin-password-value">
                    {isAdminPasswordVisible && adminPassword ? adminPassword : '************'}
                  </code>
                  <div className="ml-auto flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => void handleToggleAdminPassword()}
                      data-testid="admin-password-toggle"
                      aria-label={isAdminPasswordVisible ? 'Hide admin password' : 'Show admin password'}
                    >
                      {isAdminPasswordVisible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2"
                      onClick={() => void handleCopyAdminPassword()}
                      data-testid="admin-password-copy"
                      aria-label="Copy admin password"
                    >
                      {adminPasswordCopiedKey ? (
                        <Check className="h-3.5 w-3.5 text-brand" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </div>
                  <p className="w-full text-xs text-muted-foreground/70" data-testid="admin-password-note">
                    Use this to connect other admin tools (e.g. pubky-cli) to your homeserver.{' '}
                    {platform === 'umbrel' ? (
                      <>
                        Do not change <code>admin_password</code> in config.toml; it would disconnect this dashboard.
                      </>
                    ) : (
                      // Elsewhere the dashboard may be reading the password from this very file.
                      <>
                        If you change <code>admin_password</code> in config.toml, restart the homeserver so both use the
                        new one. A dashboard that is given the password through <code>ADMIN_TOKEN</code> needs it
                        changed there too.
                      </>
                    )}
                  </p>
                  {adminPasswordError && (
                    <p className="w-full text-xs text-destructive" data-testid="admin-password-error">
                      {adminPasswordError}
                    </p>
                  )}
                </div>

                {saveMessage && (
                  <div
                    className={cn(
                      'flex items-start gap-2 rounded border px-3 py-2 text-sm',
                      saveMessage.type === 'success' && 'border-brand/40 bg-brand/5 text-brand',
                      saveMessage.type === 'error' && 'border-destructive/40 bg-destructive/5 text-destructive',
                      saveMessage.type === 'conflict' && 'border-amber-500/40 bg-amber-500/5 text-amber-300',
                    )}
                    data-testid={`config-save-${saveMessage.type}`}
                  >
                    {saveMessage.type === 'success' ? (
                      <CheckCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    ) : (
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    )}
                    <span>{saveMessage.text}</span>
                  </div>
                )}

                {configLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Loading…</span>
                  </div>
                ) : configError ? (
                  <div className="flex items-center gap-2 text-sm text-destructive">
                    <AlertCircle className="h-3.5 w-3.5" />
                    <span>{configError}</span>
                  </div>
                ) : isEditing ? (
                  <Textarea
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className={cn('flex-1 resize-none font-mono text-xs sm:text-sm')}
                    placeholder="Configuration file content..."
                    spellCheck={false}
                    data-testid="config-editor"
                  />
                ) : (
                  <Textarea
                    value={configValue}
                    readOnly
                    className={cn('flex-1 resize-none font-mono text-xs sm:text-sm')}
                    placeholder="Configuration file content..."
                    data-testid="config-viewer"
                  />
                )}

                {writable ? (
                  <p className="text-xs text-muted-foreground/70">
                    Sensitive fields (passwords, database URL) are masked as <code>&quot;********&quot;</code> on
                    display. Leave the placeholder untouched and the real value is preserved on save. Config changes
                    only take effect after a restart. {restartSentence}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground/70">
                    Sensitive fields (passwords, database URL) are redacted. The config volume is read-only in this
                    environment, so editing isn&apos;t available here.
                  </p>
                )}
                {configMtime && (
                  <p className="text-[10px] text-muted-foreground/50" data-testid="config-mtime">
                    Last modified on disk: {new Date(configMtime).toLocaleString()}
                  </p>
                )}
              </div>
            )}

            {activeTab === 'cloudflare' && isCloudflareTabVisible && (
              <div className="flex flex-1 flex-col gap-6 overflow-y-auto">
                {cfLoading ? (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                    <span>Loading…</span>
                  </div>
                ) : cfError ? (
                  <div className="flex flex-col items-start gap-3" data-testid="cf-unavailable">
                    <div className="flex items-start gap-2 text-sm text-destructive">
                      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>Cloudflare settings are temporarily unavailable ({cfError}).</span>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => void loadCloudflare()}
                      data-testid="cf-retry"
                    >
                      Retry
                    </Button>
                  </div>
                ) : (
                  <>
                    {/* Status: the single surface that asserts Cloudflare state. */}
                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Status</span>
                        <span
                          className={cn(
                            'inline-flex items-center gap-1.5 text-sm font-medium',
                            cfMode === 'off' ? 'text-muted-foreground' : 'text-brand',
                          )}
                          data-testid="cf-mode-badge"
                        >
                          <span
                            className={cn(
                              'h-1.5 w-1.5 rounded-full',
                              cfMode === 'off' ? 'bg-muted-foreground/50' : 'bg-brand',
                            )}
                          />
                          {MODE_LABELS[cfMode]}
                        </span>
                      </div>

                      {cfStatusCallout && <RestartCallout>{cfStatusCallout}</RestartCallout>}
                      {/* A setup just completed in this session: point at what
                          comes after instead of leaving the user at a dead end. */}
                      {recentChange && (
                        <p className="text-xs text-muted-foreground" data-testid="cf-next-step">
                          Next: create an invite in the Invites tab so you can sign up from Pubky Ring.
                        </p>
                      )}
                      {cfMode !== 'off' && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between gap-3">
                            {(() => {
                              const addr = cfMode === 'preview' ? previewUrl : cfConfig?.domain;
                              if (!addr) {
                                return (
                                  <code
                                    className="truncate font-mono text-xs text-muted-foreground"
                                    data-testid="cf-status-address"
                                  >
                                    {cfMode === 'preview' ? 'temporary address pending…' : ''}
                                  </code>
                                );
                              }
                              // Drop :443 and infer https so the address opens
                              // when clicked instead of failing on host:443.
                              const link = publicAddressLink(addr);
                              return (
                                <a
                                  href={link.href}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="min-w-0 truncate font-mono text-xs text-brand underline-offset-2 hover:underline"
                                  data-testid="cf-status-address"
                                >
                                  {link.label}
                                </a>
                              );
                            })()}
                            <div className="flex shrink-0 items-center gap-2">
                              {(cfMode === 'connect' || cfMode === 'token') && cfConfig?.domain && (
                                <>
                                  {publishState === 'published' && (
                                    <span className="text-xs text-brand" data-testid="cf-status-published">
                                      Published
                                    </span>
                                  )}
                                  {publishState === 'pending' && (
                                    <span className="text-xs text-amber-400" data-testid="cf-status-unpublished">
                                      Restart to publish
                                    </span>
                                  )}
                                  {healthStatus === 'ok' && (
                                    <span className="text-xs text-brand" data-testid="cf-status-reachable">
                                      Reachable
                                    </span>
                                  )}
                                  {/* A failed probe carries a long reason, so it is not shown
                                      inline here - it renders on its own wrapping line below the
                                      row so it never forces horizontal scroll. */}
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-7 px-2 text-xs"
                                    disabled={healthStatus === 'checking'}
                                    onClick={() => checkHealth(cfConfig.domain!)}
                                    data-testid="cf-check"
                                  >
                                    {healthStatus === 'checking' ? (
                                      <RefreshCw className="h-3 w-3 animate-spin" />
                                    ) : (
                                      'Check'
                                    )}
                                  </Button>
                                </>
                              )}
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-7 px-2 text-xs text-destructive hover:text-destructive"
                                onClick={() => void handleDisconnectAll()}
                                data-testid="cf-disconnect"
                              >
                                {confirmDisconnect ? 'Confirm?' : 'Disconnect'}
                              </Button>
                            </div>
                          </div>
                          {(cfMode === 'connect' || cfMode === 'token') &&
                            cfConfig?.domain &&
                            healthStatus === 'fail' && (
                              <p className="text-xs break-words text-destructive" data-testid="cf-status-unreachable">
                                Not reachable{healthError ? ` (${healthError})` : ''}
                              </p>
                            )}
                        </div>
                      )}

                      {/* Consequences stated BEFORE the confirming click. */}
                      {confirmDisconnect && (
                        <div
                          className="space-y-2 rounded border border-destructive/40 bg-destructive/5 p-3"
                          data-testid="cf-disconnect-consequences"
                        >
                          <p className="text-xs text-foreground">
                            Removes this dashboard&apos;s Cloudflare setup. The tunnel and DNS record stay in your
                            Cloudflare account until you delete them there. Your public address stops working after the
                            next restart.
                          </p>
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            onClick={() => setConfirmDisconnect(false)}
                            data-testid="cf-disconnect-cancel"
                          >
                            Cancel
                          </Button>
                        </div>
                      )}

                      {/* Action feedback (e.g. a failed disconnect or a manual
                          save) lives with the Status surface so it stays
                          visible regardless of which disclosure is open. */}
                      {cfMessage && (
                        <div
                          className={cn(
                            'flex items-center gap-2 text-sm',
                            cfMessage.type === 'error' ? 'text-destructive' : 'text-brand',
                          )}
                          data-testid="cf-message"
                        >
                          {cfMessage.type === 'error' ? (
                            <AlertCircle className="h-3.5 w-3.5" />
                          ) : (
                            <CheckCircle className="h-3.5 w-3.5" />
                          )}
                          <span>{cfMessage.text}</span>
                        </div>
                      )}
                    </div>

                    <div className="h-px bg-border/50" />

                    {/* With an active mode the setup cards are demoted to a
                        "switch method" disclosure; the Status surface above is
                        what says "connected". */}
                    {cfMode !== 'off' && (
                      <DisclosureToggle
                        open={showSetupMethods}
                        onToggle={() => setShowSetupMethods((s) => !s)}
                        label="Switch setup method"
                        testId="cf-switch-method-toggle"
                      />
                    )}

                    {(cfMode === 'off' || showSetupMethods) && (
                      <div key={setupNonce} className="flex flex-col gap-6">
                        {/* Option Z: browser-auth connect (primary path) */}
                        <CloudflareConnect onConfigured={(h, m) => handleAutoConfigured(h, 'connect', m)} />

                        <div className="h-px bg-border/50" />

                        {/* Option Y: API-token automatic setup (collapsed) */}
                        <DisclosureToggle
                          open={showApiTokenSetup}
                          onToggle={() => setShowApiTokenSetup((s) => !s)}
                          label="Set up with an API token instead"
                          testId="cf-api-token-toggle"
                        />
                        {showApiTokenSetup && (
                          <CloudflareAutoSetup onConfigured={(h, m) => handleAutoConfigured(h, 'token', m)} />
                        )}

                        {/* Option W: no-account published preview */}
                        <CloudflarePreview onEnabled={handlePreviewEnabled} />

                        <div className="h-px bg-border/50" />

                        {/* Option X: manual setup (collapsed escape hatch) */}
                        <DisclosureToggle
                          open={showManualSetup}
                          onToggle={() => setShowManualSetup((s) => !s)}
                          label="Set up manually instead"
                          testId="cf-manual-toggle"
                        />

                        {showManualSetup && (
                          <>
                            {/* Configuration form. Save feedback renders on the
                                Status surface above so it survives this
                                disclosure being closed. */}
                            <form onSubmit={handleCfSave} className="space-y-5">
                              <div className="space-y-1.5">
                                <Label htmlFor="cf-domain" className="text-xs text-muted-foreground">
                                  Public address
                                </Label>
                                <Input
                                  id="cf-domain"
                                  type="text"
                                  placeholder="pubky.yourdomain.com"
                                  value={cfDomain}
                                  onChange={(e) => setCfDomain(e.target.value)}
                                  className="font-mono text-sm"
                                  autoComplete="off"
                                />
                              </div>
                              <div className="space-y-1.5">
                                <Label htmlFor="cf-token" className="text-xs text-muted-foreground">
                                  Tunnel token
                                </Label>
                                <Input
                                  id="cf-token"
                                  type="password"
                                  placeholder="Paste token from Cloudflare Zero Trust"
                                  value={cfToken}
                                  onChange={(e) => setCfToken(e.target.value)}
                                  className="font-mono text-sm"
                                  autoComplete="off"
                                />
                              </div>
                              <Button type="submit" disabled={cfSaving} size="sm">
                                {cfSaving ? 'Saving…' : 'Save'}
                              </Button>
                            </form>

                            <p className="text-xs text-muted-foreground/70">
                              Point the tunnel hostname to{' '}
                              <code className="text-muted-foreground">http://homeserver:6286</code>. The tunnel picks
                              the token up by itself; after saving, a restart publishes your public address.{' '}
                              <a
                                href="/cloudflare-guide"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-brand underline-offset-2 hover:underline"
                              >
                                Full setup guide ↗
                              </a>
                            </p>
                          </>
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
