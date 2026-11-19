import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteManagementProps } from '@/components/organisms/InviteManagement';
import type { UserEditorProps } from '@/components/organisms/UserEditor';
import type { UserListProps } from '@/components/organisms/UserList';
import DashboardPage from './page';

const generateInvite = vi.fn();
const disableUser = vi.fn();
const enableUser = vi.fn();
const refetchInfo = vi.fn();

vi.mock('@/hooks/admin', () => ({
  useAdminInfo: () => ({
    data: { num_users: 0, num_signup_codes: 0, num_unused_signup_codes: 0 },
    isLoading: false,
    error: null,
    refetch: refetchInfo,
    refresh: vi.fn(),
  }),
  useAdminActions: () => ({ generateInvite, disableUser, enableUser, generateInviteError: null }),
}));
vi.mock('@/components/providers/PlatformProvider', () => ({ usePlatform: () => 'generic' }));

// The page is tested for what it hands the Invites and Users tabs; their
// cards and every other section are stood in for.
let inviteProps: InviteManagementProps;
let userListProps: UserListProps;
let userEditorProps: UserEditorProps;
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
vi.mock('@/components/organisms/UserList', () => ({
  UserList: (props: UserListProps) => {
    userListProps = props;
    return <div data-testid="user-list">{props.refreshKey}</div>;
  },
}));
vi.mock('@/components/organisms/UserEditor', () => ({
  UserEditor: (props: UserEditorProps) => {
    userEditorProps = props;
    return <div data-testid="user-editor">{props.openRequest?.pubkey}</div>;
  },
}));
vi.mock('@/components/organisms/ConfigDialog', () => ({ ConfigDialog: () => null }));
vi.mock('@/components/organisms/DashboardLogs', () => ({ DashboardLogs: () => null }));
// Every tab's content is mounted, so the Invites tab is there without a click.
vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TabsList: () => null,
  TabsTrigger: () => null,
  TabsContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

/** The quota route asked about a pubky that is no user: a homeserver with the route says so in a body. */
const QUOTA_PROBE = '/api/admin/users/8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo/quota';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/** Answers the page's availability probes; `overrides` replaces the answer for a path. */
function stubProbes(overrides: Record<string, () => Response> = {}) {
  const answers: Record<string, () => Response> = {
    '/api/server-config': () => json({ writable: false, defaultQuota: { storage_quota_mb: 500 } }),
    '/api/cloudflare-config': () => json({ supported: false }),
    '/api/logs': () => new Response(null, { status: 503 }),
    '/api/admin/users': () => json({ items: [], next_cursor: null }),
    [QUOTA_PROBE]: () => new Response('Not Found', { status: 404 }),
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
  disableUser.mockReset().mockResolvedValue(undefined);
  enableUser.mockReset().mockResolvedValue(undefined);
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

describe('DashboardPage users', () => {
  it('shows the list and the editor on a homeserver with both routes', async () => {
    stubProbes();
    render(<DashboardPage />);
    await screen.findByTestId('user-list');
    await screen.findByTestId('user-editor');
    expect(userEditorProps.hasUserRoutes).toBe(true);
  });

  it('shows the editor alone on a homeserver that cannot list its accounts', async () => {
    stubProbes({ '/api/admin/users': () => new Response(null, { status: 404 }) });
    render(<DashboardPage />);
    await screen.findByTestId('user-editor');
    expect(screen.queryByTestId('user-list')).toBeNull();
    expect(userEditorProps.hasUserRoutes).toBe(false);
  });

  it('shows neither when the quota route answers an empty 404, the mark of a homeserver without it', async () => {
    stubProbes({
      '/api/admin/users': () => new Response(null, { status: 404 }),
      [QUOTA_PROBE]: () => new Response(null, { status: 404 }),
    });
    render(<DashboardPage />);
    await screen.findByTestId('token-list');
    expect(screen.queryByTestId('user-list')).toBeNull();
    expect(screen.queryByTestId('user-editor')).toBeNull();
  });

  it('takes any answer but an empty 404 from the quota route as the route being there', async () => {
    stubProbes({ [QUOTA_PROBE]: () => new Response('Invalid PublicKey', { status: 400 }) });
    const { unmount } = render(<DashboardPage />);
    await screen.findByTestId('user-editor');
    unmount();

    stubProbes({ [QUOTA_PROBE]: () => json({ effective: {}, overrides: {} }) });
    render(<DashboardPage />);
    await screen.findByTestId('user-editor');
  });

  it('opens a listed account in the editor, and again when asked twice', async () => {
    stubProbes();
    render(<DashboardPage />);
    await screen.findByTestId('user-list');
    act(() => userListProps.onManage('pk1'));
    expect(userEditorProps.openRequest).toEqual({ pubkey: 'pk1', nonce: 1 });
    act(() => userListProps.onManage('pk1'));
    expect(userEditorProps.openRequest).toEqual({ pubkey: 'pk1', nonce: 2 });
  });

  it('reloads the list and re-reads the stats after an account is disabled or enabled', async () => {
    stubProbes();
    render(<DashboardPage />);
    expect((await screen.findByTestId('user-list')).textContent).toBe('0');

    await act(() => userEditorProps.onDisableUser('pk1'));
    expect(disableUser).toHaveBeenCalledWith('pk1');
    expect(screen.getByTestId('user-list').textContent).toBe('1');
    expect(refetchInfo).toHaveBeenCalledTimes(1);

    await act(() => userEditorProps.onEnableUser('pk1'));
    expect(enableUser).toHaveBeenCalledWith('pk1');
    expect(screen.getByTestId('user-list').textContent).toBe('2');
    expect(refetchInfo).toHaveBeenCalledTimes(2);
  });

  it('reloads the list after an action that failed, since the account may have changed all the same', async () => {
    stubProbes();
    enableUser.mockRejectedValue(new Error('homeserver restarting'));
    disableUser.mockRejectedValue(new Error('homeserver restarting'));
    render(<DashboardPage />);
    await screen.findByTestId('user-list');

    await act(async () => {
      await expect(userEditorProps.onEnableUser('pk1')).rejects.toThrow('homeserver restarting');
    });
    expect(screen.getByTestId('user-list').textContent).toBe('1');
    expect(refetchInfo).toHaveBeenCalledTimes(1);

    await act(async () => {
      await expect(userEditorProps.onDisableUser('pk1')).rejects.toThrow('homeserver restarting');
    });
    expect(screen.getByTestId('user-list').textContent).toBe('2');
  });
});
