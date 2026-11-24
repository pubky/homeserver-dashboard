'use client';

import { useState, useCallback } from 'react';
import { WebDavService } from '@/services/webdav';
import type { WebDavDirectory, WebDavError } from '@/services/webdav';

export function useWebDav() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<WebDavError | null>(null);

  // The service talks to the dashboard's API routes; credentials are server-side.
  const getService = useCallback((): WebDavService => new WebDavService(), []);

  const listDirectory = useCallback(
    async (path: string): Promise<{ directory: WebDavDirectory } | { error: WebDavError }> => {
      setIsLoading(true);
      setError(null);

      try {
        const service = getService();
        const directory = await service.listDirectory(path);
        return { directory };
      } catch (err) {
        const webdavError: WebDavError =
          err instanceof Error ? { message: err.message, status: 0 } : (err as WebDavError);
        setError(webdavError);
        return { error: webdavError };
      } finally {
        setIsLoading(false);
      }
    },
    [getService],
  );

  const readFile = useCallback(
    async (path: string): Promise<string | null> => {
      setIsLoading(true);
      setError(null);

      try {
        const service = getService();
        const content = await service.readFile(path);
        return content;
      } catch (err) {
        const webdavError: WebDavError =
          err instanceof Error ? { message: err.message, status: 0 } : (err as WebDavError);
        setError(webdavError);
        return null;
      } finally {
        setIsLoading(false);
      }
    },
    [getService],
  );

  const writeFile = useCallback(
    async (path: string, content: string, contentType?: string): Promise<boolean> => {
      setIsLoading(true);
      setError(null);

      try {
        const service = getService();
        await service.writeFile(path, content, contentType);
        return true;
      } catch (err) {
        const webdavError: WebDavError =
          err instanceof Error ? { message: err.message, status: 0 } : (err as WebDavError);
        setError(webdavError);
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [getService],
  );

  const deleteFile = useCallback(
    async (path: string): Promise<boolean> => {
      setIsLoading(true);
      setError(null);

      try {
        const service = getService();
        await service.delete(path);
        return true;
      } catch (err) {
        const webdavError: WebDavError =
          err instanceof Error ? { message: err.message, status: 0 } : (err as WebDavError);
        setError(webdavError);
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [getService],
  );

  const createDirectory = useCallback(
    async (path: string): Promise<boolean> => {
      setIsLoading(true);
      setError(null);

      try {
        const service = getService();
        await service.createDirectory(path);
        return true;
      } catch (err) {
        const webdavError: WebDavError =
          err instanceof Error ? { message: err.message, status: 0 } : (err as WebDavError);
        setError(webdavError);
        return false;
      } finally {
        setIsLoading(false);
      }
    },
    [getService],
  );

  return {
    listDirectory,
    readFile,
    writeFile,
    deleteFile,
    createDirectory,
    isLoading,
    error,
  };
}
