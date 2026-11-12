import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteManagementProps } from '@/components/organisms/InviteManagement';
import DashboardPage from './page';

const generateInvite = vi.fn();
const refetchInfo = vi.fn();

vi.mock('@/hooks/admin', () => ({
  useAdminInfo: () => ({
    data: { num_users: 0, num_signup_codes: 0, num_unused_signup_codes: 0 },
    isLoading: false,
    error: null,
    refetch: refetchInfo,
    refresh: vi.fn(),
  }),
  useAdminActions: () => ({ generateInvite, disableUser: vi.fn(), enableUser: vi.fn(), generateInviteError: null }),
  useDisabledUsers: () => ({ items: [], nextCursor: null, error: null, refetch: vi.fn(), loadMore: vi.fn() }),
}));
vi.mock('@/components/providers/PlatformProvider', () => ({ usePlatform: () => 'generic' }));

// The page is tested for what it hands the Invites tab; the tab's cards and
// every other section are stood in for.
let inviteProps: InviteManagementProps;
vi.mock('@/components/organisms/InviteManagement', () => ({
  InviteManagement: (props: InviteManagementProps) => {
    inviteProps = props;
    return null;
  },
}));
vi.mock('@/components/organisms/SignupTokenList', () => ({
  SignupTokenList: ({ refreshKey }: { refreshKey: number }) => <div data-testid="token-list">{refreshKey}</div>,
}));
vi.mock('@/components/organisms/DashboardOverview', () => ({
  DashboardOverview: () => null,
  useSetupGuideDismissal: () => ({ dismissed: true, dismiss: vi.fn(), restore: vi.fn() }),
}));
vi.mock('@/components/organisms/DashboardNavbar', () => ({ DashboardNavbar: () => null }));
vi.mock('@/components/organisms/ApiExplorer', () => ({ ApiExplorer: () => null }));
vi.mock('@/components/organisms/FileBrowser', () => ({ FileBrowser: () => null }));
vi.mock('@/components/organisms/DisabledUsersManagement', () => ({ DisabledUsersManagement: () => null }));
vi.mock('@/components/organisms/ConfigDialog', () => ({ ConfigDialog: () => null }));
vi.mock('@/components/organisms/DashboardLogs', () => ({ DashboardLogs: () => null }));
// Every tab's content is mounted, so the Invites tab is there without a click.
vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: () => null,
  TabsTrigger: () => null,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** Answers the page's availability probes; `overrides` replaces the answer for a path. */
function stubProbes(overrides: Record<string, () => Response> = {}) {
  const answers: Record<string, () => Response> = {
    '/api/server-config': () => json({ writable: false, defaultQuota: { storage_quota_mb: 500 } }),
    '/api/cloudflare-config': () => json({ supported: false }),
    '/api/logs': () => new Response(null, { status: 503 }),
    '/api/admin/users/disabled': () => new Response(null, { status: 404 }),
    '/api/admin/signup_tokens': () => json({ items: [], next_cursor: null }),
    ...overrides,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => answers[new URL(String(input), 'http://localhost').pathname]()),
  );
}

beforeEach(() => {
  generateInvite.mockReset().mockResolvedValue('AAAA-BBBB-CCCC');
  refetchInfo.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('DashboardPage invites', () => {
  it('lists the invite codes when the homeserver has the listing route', async () => {
    stubProbes();
    render(<DashboardPage />);
    await screen.findByTestId('token-list');
    expect(inviteProps.codesListed).toBe(true);
  });

  it('shows no list on a homeserver without the route', async () => {
    stubProbes({ '/api/admin/signup_tokens': () => new Response(null, { status: 404 }) });
    render(<DashboardPage />);
    await waitFor(() => expect(inviteProps.homeserverDefaults).not.toBeNull());
    expect(screen.queryByTestId('token-list')).toBeNull();
    expect(inviteProps.codesListed).toBe(false);
  });

  it("gives the invite form the homeserver's default limits, or null when the config is not readable", async () => {
    stubProbes();
    const { unmount } = render(<DashboardPage />);
    await waitFor(() => expect(inviteProps.homeserverDefaults).toEqual({ storage_quota_mb: 500 }));
    unmount();

    stubProbes({ '/api/server-config': () => new Response(null, { status: 404 }) });
    render(<DashboardPage />);
    await screen.findByTestId('token-list');
    expect(inviteProps.homeserverDefaults).toBeNull();
  });

  it('returns the new code, reloads the list and re-reads the stats after an invite is created', async () => {
    stubProbes();
    render(<DashboardPage />);
    expect((await screen.findByTestId('token-list')).textContent).toBe('0');

    let token: string | undefined;
    await act(async () => {
      token = await inviteProps.onGenerate({ storage_quota_mb: 250 });
    });
    expect(token).toBe('AAAA-BBBB-CCCC');
    expect(generateInvite).toHaveBeenCalledWith({ storage_quota_mb: 250 });
    expect(screen.getByTestId('token-list').textContent).toBe('1');
    expect(refetchInfo).toHaveBeenCalledTimes(1);
  });

  it('leaves the list and the stats alone when creating fails', async () => {
    stubProbes();
    generateInvite.mockRejectedValue(new Error('Invalid rate'));
    render(<DashboardPage />);
    await screen.findByTestId('token-list');

    await act(async () => {
      await expect(inviteProps.onGenerate({ rate_read: '10mb' })).rejects.toThrow('Invalid rate');
    });
    expect(screen.getByTestId('token-list').textContent).toBe('0');
    expect(refetchInfo).not.toHaveBeenCalled();
  });
});
