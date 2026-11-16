import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminUser } from '@/services/admin/admin.types';
import { UserList } from './UserList';

const ALICE = 'whgxto9xtroaih7ict9chtuxh1xmbpmci5qd71jsen3ow3bscipy';
const BOB = 'o1gg96ewuojmopcjbz8895478wdtxtzzuxnfjjz8o8e77csa1ngo';
const user = (pubky: string, extra: Partial<AdminUser> = {}): AdminUser => ({
  pubky,
  created_at: '2026-10-22T10:00:00',
  disabled: false,
  used_bytes: 30521,
  quota: { effective: { storage_quota_mb: 'unlimited' }, overrides: {} },
  ...extra,
});
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let users: AdminUser[];

beforeEach(() => {
  users = [
    user(ALICE),
    user(BOB, {
      disabled: true,
      used_bytes: 450 * 1024 * 1024,
      quota: { effective: { storage_quota_mb: 500 }, overrides: { storage_quota_mb: 500 } },
    }),
  ];
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const state = url.searchParams.get('state');
    if (url.searchParams.get('cursor')) return json({ items: [user('third')], next_cursor: null });
    const items = state === 'disabled' ? users.filter((u) => u.disabled) : users;
    return json({ items, next_cursor: state === 'all' ? BOB : null });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UserList', () => {
  it('lists accounts newest first with usage, allowance and status, and opens one in the editor', async () => {
    const onManage = vi.fn();
    render(<UserList numUsers={2} onManage={onManage} />);
    const rows = await screen.findAllByTestId('user-row');
    expect(rows).toHaveLength(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      '/api/admin/users?state=all&sort_by=created_at&reverse=true&limit=10',
    );
    expect(screen.getByText('Users (2)')).toBeTruthy();
    expect(rows[0].textContent).toContain('whgxto9x…bscipy');
    expect(rows[0].textContent).toContain('30 KB, no limit');
    expect(rows[1].textContent).toContain('450 MB of 500 MB');
    expect(rows[1].textContent).toContain('(90%)');
    expect(rows[1].querySelector('[data-testid="user-disabled"]')).toBeTruthy();
    expect(rows[0].querySelector('[data-testid="user-disabled"]')).toBeNull();
    fireEvent.click(screen.getAllByRole('button', { name: 'Manage' })[1]);
    expect(onManage).toHaveBeenCalledWith(BOB);
  });

  it('filters by state and orders by storage', async () => {
    render(<UserList onManage={vi.fn()} />);
    await screen.findAllByTestId('user-row');
    fireEvent.click(screen.getByRole('button', { name: 'Disabled' }));
    await waitFor(() => expect(screen.getAllByTestId('user-row')).toHaveLength(1));
    expect(String(fetchMock.mock.calls[1][0])).toContain('state=disabled');
    fireEvent.click(screen.getByRole('button', { name: 'Most storage' }));
    await waitFor(() => expect(String(fetchMock.mock.calls[2][0])).toContain('sort_by=used_bytes'));
  });

  it('loads the next page inside the scrolling box', async () => {
    render(<UserList onManage={vi.fn()} />);
    await screen.findAllByTestId('user-row');
    const more = screen.getByTestId('user-more');
    expect(screen.getByTestId('user-scroll').contains(more)).toBe(true);
    fireEvent.click(more);
    await waitFor(() => expect(screen.getAllByTestId('user-row')).toHaveLength(3));
    expect(screen.queryByTestId('user-more')).toBeNull();
  });

  it('reloads when refreshKey changes, and shows a load failure', async () => {
    const { rerender } = render(<UserList onManage={vi.fn()} refreshKey={0} />);
    await screen.findAllByTestId('user-row');
    rerender(<UserList onManage={vi.fn()} refreshKey={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fetchMock.mockResolvedValue(new Response('db down', { status: 500 }));
    rerender(<UserList onManage={vi.fn()} refreshKey={2} />);
    expect((await screen.findByText('Could not load users')).textContent).toBeTruthy();
  });
});
