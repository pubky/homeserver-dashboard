import { useCallback, useState } from 'react';
import { AdminService } from '@/services/admin/admin';
import type { UserQuota } from '@/services/admin/admin.types';

const getService = () => new AdminService();

export function useAdminActions() {
  const [isDeletingUrl, setIsDeletingUrl] = useState(false);
  const [isGeneratingInvite, setIsGeneratingInvite] = useState(false);
  const [deleteUrlError, setDeleteUrlError] = useState<Error | null>(null);
  const [generateInviteError, setGenerateInviteError] = useState<Error | null>(null);

  const deleteUrl = useCallback(async (path: string) => {
    const service = getService();
    setIsDeletingUrl(true);
    setDeleteUrlError(null);

    try {
      await service.deleteUrl({ path });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to delete URL');
      setDeleteUrlError(error);
      throw error;
    } finally {
      setIsDeletingUrl(false);
    }
  }, []);

  const disableUser = useCallback((pubkey: string) => getService().disableUser({ pubkey }), []);

  const enableUser = useCallback((pubkey: string) => getService().enableUser({ pubkey }), []);

  /** Creates an invite, with the homeserver's default limits or the given ones, and returns its code. */
  const generateInvite = useCallback(async (limits?: UserQuota): Promise<string> => {
    const service = getService();
    setIsGeneratingInvite(true);
    setGenerateInviteError(null);

    try {
      const result = await service.generateInvite(limits);
      return result.token;
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to generate invite');
      setGenerateInviteError(error);
      throw error;
    } finally {
      setIsGeneratingInvite(false);
    }
  }, []);

  return {
    deleteUrl,
    disableUser,
    enableUser,
    generateInvite,
    isDeletingUrl,
    isGeneratingInvite,
    deleteUrlError,
    generateInviteError,
  };
}
