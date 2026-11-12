import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { USERS_PAGE_SIZE, useUsers } from './useUsers';

const user = (pubky: string) => ({
  pubky,
  created_at: '2026-10-22T10:00:00',
  disabled: false,
  used_bytes: 10,
  quota: { effective: {}, overrides: {} },
});
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.searchParams.get('cursor') === 'bbb') return json({ items: [user('ccc')], next_cursor: null });
    return json({ items: [user('aaa'), user('bbb')], next_cursor: 'bbb' });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useUsers', () => {
  it('loads the first page newest first, then more from the cursor', async () => {
    const { result } = renderHook(() => useUsers('all', 'created_at'));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((u) => u.pubky)).toEqual(['aaa', 'bbb']);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      `/api/admin/users?state=all&sort_by=created_at&reverse=true&limit=${USERS_PAGE_SIZE}`,
    );
    await act(() => result.current.loadMore());
    expect(result.current.items.map((u) => u.pubky)).toEqual(['aaa', 'bbb', 'ccc']);
    expect(result.current.nextCursor).toBeNull();
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=bbb');
  });

  it('starts over when the filter, sort or refresh key changes', async () => {
    const { result, rerender } = renderHook(
      ({ state, sort, key }: { state: 'all' | 'disabled'; sort: 'created_at' | 'used_bytes'; key: number }) =>
        useUsers(state, sort, key),
      { initialProps: { state: 'all', sort: 'created_at', key: 0 } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ state: 'disabled', sort: 'created_at', key: 0 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toContain('state=disabled');
    rerender({ state: 'disabled', sort: 'used_bytes', key: 0 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(String(fetchMock.mock.calls[2][0])).toContain('sort_by=used_bytes');
    rerender({ state: 'disabled', sort: 'used_bytes', key: 1 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
  });

  it('drops the accounts it showed when the next read fails', async () => {
    const { result, rerender } = renderHook(({ state }) => useUsers(state, 'created_at'), {
      initialProps: { state: 'all' as 'all' | 'disabled' },
    });
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    fetchMock.mockResolvedValue(new Response('db down', { status: 500 }));
    rerender({ state: 'disabled' });
    await waitFor(() => expect(result.current.error?.message).toBe('db down'));
    expect(result.current.items).toEqual([]);
    expect(result.current.nextCursor).toBeNull();
  });

  it('reports a failure', async () => {
    fetchMock.mockResolvedValue(new Response('db down', { status: 500 }));
    const { result } = renderHook(() => useUsers('all', 'created_at'));
    await waitFor(() => expect(result.current.error?.message).toBe('db down'));
  });
});
