'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAdminInfo, useAdminActions } from '@/hooks/admin';
import { usePlatform } from '@/components/providers/PlatformProvider';
import { DashboardNavbar } from '@/components/organisms/DashboardNavbar';
import { DashboardOverview, useSetupGuideDismissal } from '@/components/organisms/DashboardOverview';
import { ApiExplorer } from '@/components/organisms/ApiExplorer';
import { FileBrowser } from '@/components/organisms/FileBrowser';
import { ConfigDialog } from '@/components/organisms/ConfigDialog';
import { InviteManagement } from '@/components/organisms/InviteManagement';
import { DashboardLogs } from '@/components/organisms/DashboardLogs';
import { SignupTokenList } from '@/components/organisms/SignupTokenList';
import { UserEditor } from '@/components/organisms/UserEditor';
import { UserList } from '@/components/organisms/UserList';
import type { UserQuota } from '@/services/admin/admin.types';
import {
  Github,
  BookOpen,
  HelpCircle,
  Home,
  Users,
  Files,
  Plug,
  Gift,
  ScrollText,
  Cloud,
  ListChecks,
} from 'lucide-react';
import Link from 'next/link';
// The dashboard's own release version. The homeserver's version (from /info)
// is shown on the Overview card, explicitly labeled; mixing the two in the
// footer confused operators comparing against the Umbrel app version.
import packageJson from '../../../../package.json';
const dashboardVersion = packageJson.version;

// Tab availability: 'unknown' hides the tab (the endpoint never answered),
// 'available' shows it, 'unavailable' keeps a previously working tab rendered
// with an inline notice - a transient probe failure must not silently remove
// UI the operator was just using.
type TabAvailability = 'unknown' | 'available' | 'unavailable';

const downgrade = (prev: TabAvailability): TabAvailability => (prev === 'unknown' ? 'unknown' : 'unavailable');

/**
 * Any well-formed pubky works for probing the per-user quota route: a missing
 * user is a 404 with a body ("Not Found"), a homeserver without the route
 * answers an empty 404. This is the pubky-testnet homeserver's key, which is
 * never a user on a real homeserver.
 */
const QUOTA_PROBE_PUBKY = '8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo';

async function hasQuotaRoute(response: Response): Promise<boolean> {
  if (response.ok || response.status === 400) return true;
  return response.status === 404 && (await response.text()).trim() !== '';
}

function TabUnavailableNotice() {
  return (
    <p
      className="rounded-md border border-border/60 bg-muted/10 px-3 py-2 text-sm text-muted-foreground"
      data-testid="tab-unavailable"
    >
      This section is temporarily unavailable. The homeserver may be restarting; it comes back on its own.
    </p>
  );
}

export default function DashboardPage() {
  const platform = usePlatform();
  const {
    data: info,
    isLoading: infoLoading,
    error: infoError,
    refetch: refetchInfo,
    refresh: refreshInfo,
  } = useAdminInfo();
  const { disableUser, enableUser, generateInvite, isGeneratingInvite, generateInviteError } = useAdminActions();

  // Controlled tabs: the get-started checklist's "Open Invites" CTA and the
  // footer's "Setup guide" link both need to drive the active tab.
  const [activeTab, setActiveTab] = useState('overview');
  const {
    dismissed: setupGuideDismissed,
    dismiss: dismissSetupGuide,
    restore: restoreSetupGuide,
  } = useSetupGuideDismissal();
  const handleShowSetupGuide = useCallback(() => {
    restoreSetupGuide();
    setActiveTab('overview');
  }, [restoreSetupGuide]);
  const handleGoToInvites = useCallback(() => {
    setActiveTab('invites');
  }, []);

  const [isConfigDialogOpen, setIsConfigDialogOpen] = useState(false);
  const [canOpenSettings, setCanOpenSettings] = useState(true);
  const [logsTab, setLogsTab] = useState<TabAvailability>('unknown');
  // The user list on the Users tab needs the admin listing route (homeserver 0.17+).
  const [userListAvailability, setUserListAvailability] = useState<TabAvailability>('unknown');
  const [usersRefreshKey, setUsersRefreshKey] = useState(0);
  // "Manage" on a listed account: open it in the editor below the list.
  const [userToOpen, setUserToOpen] = useState<{ pubkey: string; nonce: number } | null>(null);
  // The user editor on the Users tab needs the per-user quota route.
  const [userEditorAvailability, setUserEditorAvailability] = useState<TabAvailability>('unknown');
  // The invite code list on the Invites tab needs the homeserver's admin listing route.
  const [hasSignupTokenList, setHasSignupTokenList] = useState(false);
  const [signupTokensRefreshKey, setSignupTokensRefreshKey] = useState(0);
  const [configWritable, setConfigWritable] = useState(false);
  // The homeserver's default limits, from config.toml when the dashboard can read it; null when it cannot.
  const [homeserverDefaults, setHomeserverDefaults] = useState<UserQuota | null>(null);

  const handleSettingsClick = useCallback(() => {
    setIsConfigDialogOpen(true);
  }, []);

  // "Fix it" on the Overview's domain-health chip: open Settings directly on
  // the Cloudflare tab (the nonce forces the tab even if the dialog last
  // showed Config).
  const [cloudflareFocusNonce, setCloudflareFocusNonce] = useState(0);
  const handleFixCloudflare = useCallback(() => {
    setCloudflareFocusNonce((n) => n + 1);
    setIsConfigDialogOpen(true);
  }, []);

  // The Overview reads Cloudflare mode + restart-pending once on mount; bump
  // this when the Settings dialog closes so a setup/disconnect made inside the
  // dialog is reflected without a page reload.
  const [cloudflareRefreshKey, setCloudflareRefreshKey] = useState(0);
  const handleConfigDialogOpenChange = useCallback((open: boolean) => {
    setIsConfigDialogOpen(open);
    if (!open) setCloudflareRefreshKey((n) => n + 1);
  }, []);

  const handleGenerateInvite = useCallback(
    async (limits?: UserQuota) => {
      // The failure is surfaced via generateInviteError; the throw is passed on
      // so the card knows nothing was created. The new code is not held back
      // for the stats to be read again.
      const token = await generateInvite(limits);
      setSignupTokensRefreshKey((n) => n + 1);
      void refetchInfo();
      return token;
    },
    [generateInvite, refetchInfo],
  );

  // After either action, also one that failed part-way, the list and the
  // stats are read again: the account may have changed all the same.
  const refreshUsers = useCallback(async () => {
    setUsersRefreshKey((n) => n + 1);
    await refetchInfo();
  }, [refetchInfo]);

  const handleDisableUser = useCallback(
    async (pubkey: string) => {
      try {
        await disableUser(pubkey);
      } finally {
        await refreshUsers();
      }
    },
    [disableUser, refreshUsers],
  );

  const handleEnableUser = useCallback(
    async (pubkey: string) => {
      try {
        await enableUser(pubkey);
      } finally {
        await refreshUsers();
      }
    },
    [enableUser, refreshUsers],
  );

  const handleManageUser = useCallback((pubkey: string) => {
    setUserToOpen((prev) => ({ pubkey, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);

  // Probing while the homeserver is still booting reports everything as
  // missing; once /info recovers from an error, probe again so tabs come
  // back without a manual page reload.
  const [detectionNonce, setDetectionNonce] = useState(0);
  const wasInfoErroredRef = useRef(false);
  useEffect(() => {
    if (infoError) {
      wasInfoErroredRef.current = true;
      return;
    }
    if (info && wasInfoErroredRef.current) {
      wasInfoErroredRef.current = false;
      setDetectionNonce((n) => n + 1);
    }
  }, [info, infoError]);

  useEffect(() => {
    let cancelled = false;

    // Per-endpoint feature probing. Each route exposes its own availability
    // (via response status, or via a flag in the body):
    //   - /api/server-config - 2xx means readable; body's `writable` flag drives edit affordance
    //   - /api/cloudflare-config - body's `supported` flag drives the Cloudflare tab
    //   - /api/logs - 2xx means the log file is readable, drives the Logs tab
    //   - /api/admin/users - 2xx means the homeserver lists its accounts
    //     (0.17+); drives the user list on the Users tab
    //   - /api/admin/users/{pubky}/quota - the per-user quota route; drives the
    //     user editor, which also shows the Users tab
    //   - /api/admin/signup_tokens - 2xx means the homeserver lists its invite
    //     codes; drives the code list on the Invites tab
    const detectAvailability = async () => {
      try {
        const [configRes, cloudflareRes, logsRes, usersRes, signupTokensRes, quotaRes] = await Promise.all([
          fetch('/api/server-config'),
          fetch('/api/cloudflare-config'),
          fetch('/api/logs?lines=0'),
          fetch('/api/admin/users?limit=1'),
          fetch('/api/admin/signup_tokens?limit=1'),
          fetch(`/api/admin/users/${QUOTA_PROBE_PUBKY}/quota`),
        ]);
        const isQuotaSupported = await hasQuotaRoute(quotaRes);

        let isCloudflareSupported = false;
        if (cloudflareRes.ok) {
          const cloudflareData = (await cloudflareRes.json()) as { supported?: boolean };
          isCloudflareSupported = Boolean(cloudflareData.supported);
        } else if (cloudflareRes.status >= 500) {
          // A read failure is "temporarily unavailable", not "unsupported";
          // keep Settings reachable so the dialog can offer a retry.
          isCloudflareSupported = true;
        }

        let isConfigWritable = false;
        let defaults: UserQuota | null = null;
        if (configRes.ok) {
          const configData = (await configRes.json()) as { writable?: boolean; defaultQuota?: UserQuota };
          isConfigWritable = Boolean(configData.writable);
          defaults = configData.defaultQuota ?? null;
        }

        if (!cancelled) {
          setCanOpenSettings(configRes.ok || isCloudflareSupported);
          setConfigWritable(isConfigWritable);
          setHomeserverDefaults(defaults);
          setLogsTab((prev) => (logsRes.ok ? 'available' : downgrade(prev)));
          setUserListAvailability((prev) => (usersRes.ok ? 'available' : downgrade(prev)));
          setUserEditorAvailability((prev) => (isQuotaSupported ? 'available' : downgrade(prev)));
          setHasSignupTokenList(signupTokensRes.ok);
        }
      } catch {
        // Keep settings button visible when detection fails to avoid blocking access.
        if (!cancelled) {
          setCanOpenSettings(true);
          setLogsTab(downgrade);
          setUserListAvailability(downgrade);
          setUserEditorAvailability(downgrade);
          setHasSignupTokenList(false);
        }
      }
    };

    void detectAvailability();
    return () => {
      cancelled = true;
    };
  }, [detectionNonce]);

  // The API Explorer is a developer tool; show its tab only when explicitly
  // enabled at build time (NEXT_PUBLIC_API_EXPLORER=true) so production users
  // don't see it. Base tabs (Overview, Invites, Files) are always present;
  // Users/Logs/API are optional, so the column count is 3 + however many show.
  const apiExplorerEnabled = process.env.NEXT_PUBLIC_API_EXPLORER === 'true';
  // The Users tab shows for either of its parts: the list (users route) or
  // the editor (quota route).
  const showUsersTab = userListAvailability !== 'unknown' || userEditorAvailability !== 'unknown';
  const optionalTabCount = (showUsersTab ? 1 : 0) + (logsTab !== 'unknown' ? 1 : 0) + (apiExplorerEnabled ? 1 : 0);
  const tabColsClass =
    optionalTabCount >= 3
      ? 'md:grid-cols-6'
      : optionalTabCount === 2
        ? 'md:grid-cols-5'
        : optionalTabCount === 1
          ? 'md:grid-cols-4'
          : 'md:grid-cols-3';

  return (
    <div className="min-h-screen bg-background text-foreground">
      <main>
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-2 px-4 py-6 sm:gap-3 sm:px-6 sm:py-10">
          <DashboardNavbar
            onSettingsClick={canOpenSettings ? handleSettingsClick : undefined}
            showSettingsButton={canOpenSettings}
          />

          <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
            <TabsList className={`flex w-full scrollbar-none flex-nowrap overflow-x-auto md:grid ${tabColsClass}`}>
              <TabsTrigger value="overview" className="shrink-0 gap-2 text-xs sm:text-sm [&_svg]:size-4">
                <Home className="shrink-0" />
                Overview
              </TabsTrigger>
              {showUsersTab && (
                <TabsTrigger
                  value="users"
                  className="shrink-0 gap-2 text-xs sm:text-sm [&_svg]:size-4"
                  data-testid="tab-users"
                >
                  <Users className="shrink-0" />
                  Users
                </TabsTrigger>
              )}
              <TabsTrigger value="invites" className="shrink-0 gap-2 text-xs sm:text-sm [&_svg]:size-4">
                <Gift className="shrink-0" />
                Invites
              </TabsTrigger>
              <TabsTrigger value="files" className="shrink-0 gap-2 text-xs sm:text-sm [&_svg]:size-4">
                <Files className="shrink-0" />
                Files
              </TabsTrigger>
              {logsTab !== 'unknown' && (
                <TabsTrigger
                  value="logs"
                  className="shrink-0 gap-2 text-xs sm:text-sm [&_svg]:size-4"
                  data-testid="tab-logs"
                >
                  <ScrollText className="shrink-0" />
                  Logs
                </TabsTrigger>
              )}
              {apiExplorerEnabled && (
                <TabsTrigger
                  value="api"
                  className="shrink-0 gap-2 text-xs sm:text-sm [&_svg]:size-4"
                  data-testid="tab-api"
                >
                  <Plug className="shrink-0" />
                  API
                </TabsTrigger>
              )}
            </TabsList>

            <TabsContent value="overview" className="space-y-4">
              <DashboardOverview
                info={info}
                isLoading={infoLoading}
                error={infoError}
                onFixCloudflare={handleFixCloudflare}
                onRetry={() => void refetchInfo()}
                onGoToInvites={handleGoToInvites}
                setupGuideDismissed={setupGuideDismissed}
                onDismissSetupGuide={dismissSetupGuide}
                cloudflareRefreshKey={cloudflareRefreshKey}
              />
            </TabsContent>

            {showUsersTab && (
              <TabsContent value="users" className="space-y-4">
                {userListAvailability === 'available' && (
                  <UserList numUsers={info?.num_users} refreshKey={usersRefreshKey} onManage={handleManageUser} />
                )}
                {userEditorAvailability === 'available' && (
                  <UserEditor
                    openRequest={userToOpen}
                    onDisableUser={handleDisableUser}
                    onEnableUser={handleEnableUser}
                    hasUserRoutes={userListAvailability === 'available'}
                  />
                )}
                {userListAvailability !== 'available' && userEditorAvailability !== 'available' && (
                  <TabUnavailableNotice />
                )}
              </TabsContent>
            )}

            <TabsContent value="invites" className="space-y-4">
              <InviteManagement
                onGenerate={handleGenerateInvite}
                isGenerating={isGeneratingInvite}
                generateError={generateInviteError?.message ?? null}
                signupCodesTotal={info?.num_signup_codes}
                signupCodesUnused={info?.num_unused_signup_codes}
                isStatsLoading={infoLoading}
                homeserverPubkey={info?.public_key ?? info?.pubkey}
                onRefreshStats={refreshInfo}
                homeserverDefaults={homeserverDefaults}
                codesListed={hasSignupTokenList}
              />
              {hasSignupTokenList && <SignupTokenList refreshKey={signupTokensRefreshKey} />}
            </TabsContent>

            <TabsContent value="files" className="space-y-4">
              <FileBrowser
                initialPath="/"
                diskUsedMB={info?.total_disk_used_mb}
                homeserverPubkey={info?.public_key ?? info?.pubkey}
              />
            </TabsContent>

            {logsTab !== 'unknown' && (
              <TabsContent value="logs" className="space-y-4">
                {logsTab === 'unavailable' ? <TabUnavailableNotice /> : <DashboardLogs />}
              </TabsContent>
            )}

            {apiExplorerEnabled && (
              <TabsContent value="api" className="space-y-4">
                <ApiExplorer />
              </TabsContent>
            )}
          </Tabs>

          {/* Config Dialog */}
          {canOpenSettings && (
            <ConfigDialog
              open={isConfigDialogOpen}
              onOpenChange={handleConfigDialogOpenChange}
              writable={configWritable}
              focusCloudflare={cloudflareFocusNonce}
            />
          )}
        </div>

        {/* Footer */}
        <footer className="mt-6 pt-4 pb-6 sm:pb-8">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 text-sm text-muted-foreground sm:px-6">
            {/* Copyright and version */}
            <div className="flex flex-col items-center justify-between gap-3 sm:flex-row sm:gap-4">
              <div className="flex flex-col items-center gap-2 text-center sm:flex-row sm:gap-4 sm:text-left">
                <span className="text-xs sm:text-sm">Dashboard</span>
                <span className="text-xs" title="App version in Umbrel = homeserver version + packaging suffix.">
                  v{dashboardVersion}
                </span>
              </div>
              <div className="flex flex-col items-center gap-2 text-center text-xs sm:flex-row sm:gap-4 sm:text-left">
                <span>Synonym Software, S.A. DE C.V. ©{new Date().getFullYear()}. All rights reserved.</span>
              </div>
            </div>

            {/* Links */}
            <div className="flex flex-wrap items-center justify-center gap-4 text-xs sm:justify-end sm:gap-6">
              {/* Way back to the dismissed get-started checklist */}
              {setupGuideDismissed === true && (
                <button
                  type="button"
                  onClick={handleShowSetupGuide}
                  className="flex cursor-pointer items-center gap-1.5 transition-colors hover:text-foreground"
                  data-testid="setup-guide-link"
                >
                  <ListChecks className="h-3.5 w-3.5" />
                  <span>Setup guide</span>
                </button>
              )}
              <Link
                href="https://github.com/pubky/pubky-homeserver/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 transition-colors hover:text-foreground"
              >
                <Github className="h-3.5 w-3.5" />
                <span>GitHub</span>
              </Link>
              <Link
                href="https://docs.pubky.org/"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 transition-colors hover:text-foreground"
              >
                <BookOpen className="h-3.5 w-3.5" />
                <span>Documentation</span>
              </Link>
              {platform === 'umbrel' && (
                <Link
                  href="/cloudflare-guide"
                  className="flex items-center gap-1.5 transition-colors hover:text-foreground"
                >
                  <Cloud className="h-3.5 w-3.5" />
                  <span>Cloudflare Tunnel guide</span>
                </Link>
              )}
              <Link
                href="https://github.com/pubky/umbrel-app-store/issues"
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1.5 transition-colors hover:text-foreground"
              >
                <HelpCircle className="h-3.5 w-3.5" />
                <span>Support</span>
              </Link>
            </div>
          </div>
        </footer>
      </main>
    </div>
  );
}
