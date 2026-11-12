import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AdminService } from '@/services/admin/admin';
import type { AdminUser, UserListState, UserSort } from '@/services/admin/admin.types';

const getService = () => new AdminService();
/** Accounts per page; the homeserver pages with a cursor, so more come on request. */
export const USERS_PAGE_SIZE = 10;

/**
 * The homeserver's accounts in `state` (admin `GET /users`), newest or largest
 * first as `sortBy` says, a page at a time. Changing a parameter or
 * `refreshKey` starts over.
 */
export function useUsers(state: UserListState, sortBy: UserSort, refreshKey = 0) {
  const [items, setItems] = useState<AdminUser[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const firstPage = useMemo(() => ({ state, sortBy, reverse: true, limit: USERS_PAGE_SIZE }), [state, sortBy]);

  const isMountedRef = useRef(true);
  const fetchIdRef = useRef(0);

  const loadFirstPage = useCallback(async () => {
    const fetchId = ++fetchIdRef.current;
    const current = () => isMountedRef.current && fetchId === fetchIdRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const page = await getService().getUsers(firstPage);
      if (!current()) return;
      setItems(page.items);
      setNextCursor(page.next_cursor);
    } catch (err) {
      if (!current()) return;
      // Not the accounts of the filter shown before.
      setItems([]);
      setNextCursor(null);
      setError(err instanceof Error ? err : new Error('Failed to load users'));
    } finally {
      if (current()) setIsLoading(false);
    }
  }, [firstPage]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || isLoadingMore) return;
    const fetchId = fetchIdRef.current;
    const current = () => isMountedRef.current && fetchId === fetchIdRef.current;
    setIsLoadingMore(true);
    try {
      const page = await getService().getUsers({ ...firstPage, cursor: nextCursor });
      if (!current()) return;
      setItems((prev) => {
        const seen = new Set(prev.map((user) => user.pubky));
        return [...prev, ...page.items.filter((user) => !seen.has(user.pubky))];
      });
      setNextCursor(page.next_cursor);
    } catch (err) {
      if (!current()) return;
      setError(err instanceof Error ? err : new Error('Failed to load more users'));
    } finally {
      if (isMountedRef.current) setIsLoadingMore(false);
    }
  }, [firstPage, isLoadingMore, nextCursor]);

  useEffect(() => {
    isMountedRef.current = true;
    void loadFirstPage();
    return () => {
      isMountedRef.current = false;
    };
  }, [loadFirstPage, refreshKey]);

  return { items, nextCursor, isLoading, isLoadingMore, error, refetch: loadFirstPage, loadMore };
}
