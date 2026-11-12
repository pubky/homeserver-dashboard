import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSignupTokens } from './useSignupTokens';

const code = (token: string, created_at: string) => ({ token, created_at, used_at: null, used_by: null });
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    // The homeserver pages by code: two pages, older codes mixed in on both.
    if (url.searchParams.get('cursor') === 'BBBB')
      return json({ items: [code('CCCC', '2026-10-20T10:00:00')], next_cursor: null });
    return json({
      items: [code('AAAA', '2026-10-01T10:00:00'), code('BBBB', '2026-10-22T10:00:00')],
      next_cursor: 'BBBB',
    });
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useSignupTokens', () => {
  it('reads every page for the state and sorts the codes newest first', async () => {
    const { result } = renderHook(() => useSignupTokens('unused'));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((i) => i.token)).toEqual(['BBBB', 'CCCC', 'AAAA']);
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/admin/signup_tokens?state=unused&limit=1000');
    expect(String(fetchMock.mock.calls[1][0])).toContain('cursor=BBBB');
  });

  it('reads again when the state or the refresh key changes', async () => {
    const { result, rerender } = renderHook(({ state, key }) => useSignupTokens(state, key), {
      initialProps: { state: 'unused' as const, key: 0 },
    });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    rerender({ state: 'unused', key: 1 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    rerender({ state: 'used' as 'unused', key: 1 });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(6));
    expect(String(fetchMock.mock.calls[4][0])).toContain('state=used');
  });

  it('orders used codes by when they were used', async () => {
    const used = (token: string, used_at: string) => ({
      ...code(token, '2026-10-01T10:00:00'),
      used_at,
      used_by: 'pk',
    });
    fetchMock.mockResolvedValue(
      json({ items: [used('AAAA', '2026-10-05T10:00:00'), used('BBBB', '2026-10-09T10:00:00')], next_cursor: null }),
    );
    const { result } = renderHook(() => useSignupTokens('used'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.items.map((item) => item.token)).toEqual(['BBBB', 'AAAA']);
  });

  it('drops the codes it showed when the next read fails', async () => {
    const { result, rerender } = renderHook(({ state }) => useSignupTokens(state), {
      initialProps: { state: 'unused' as 'unused' | 'used' },
    });
    await waitFor(() => expect(result.current.items).toHaveLength(3));
    fetchMock.mockResolvedValue(new Response('db down', { status: 500 }));
    rerender({ state: 'used' });
    await waitFor(() => expect(result.current.error?.message).toBe('db down'));
    expect(result.current.items).toEqual([]);
  });

  it('reports a failure', async () => {
    fetchMock.mockResolvedValue(new Response('db down', { status: 500 }));
    const { result } = renderHook(() => useSignupTokens('used'));
    await waitFor(() => expect(result.current.error?.message).toBe('db down'));
    expect(result.current.items).toEqual([]);
  });
});
