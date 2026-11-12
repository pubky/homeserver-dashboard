import { useCallback, useState } from 'react';
import { AdminService } from '@/services/admin/admin';
import type { UserQuota } from '@/services/admin/admin.types';

const getService = () => new AdminService();

export function useAdminActions() {
  const [isDeletingUrl, setIsDeletingUrl] = useState(false);
  const [isDisablingUser, setIsDisablingUser] = useState(false);
  const [isEnablingUser, setIsEnablingUser] = useState(false);
  const [isGeneratingInvite, setIsGeneratingInvite] = useState(false);
  const [deleteUrlError, setDeleteUrlError] = useState<Error | null>(null);
  const [disableUserError, setDisableUserError] = useState<Error | null>(null);
  const [enableUserError, setEnableUserError] = useState<Error | null>(null);
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

  const disableUser = useCallback(async (pubkey: string) => {
    const service = getService();
    setIsDisablingUser(true);
    setDisableUserError(null);

    try {
      await service.disableUser({ pubkey });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to disable user');
      setDisableUserError(error);
      throw error;
    } finally {
      setIsDisablingUser(false);
    }
  }, []);

  const enableUser = useCallback(async (pubkey: string) => {
    const service = getService();
    setIsEnablingUser(true);
    setEnableUserError(null);

    try {
      await service.enableUser({ pubkey });
    } catch (err) {
      const error = err instanceof Error ? err : new Error('Failed to enable user');
      setEnableUserError(error);
      throw error;
    } finally {
      setIsEnablingUser(false);
    }
  }, []);

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
    isDisablingUser,
    isEnablingUser,
    isGeneratingInvite,
    deleteUrlError,
    disableUserError,
    enableUserError,
    generateInviteError,
  };
}
