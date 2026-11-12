'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Ban, Check, CircleCheckBig, Search } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonSpinner } from '@/components/ui/button-spinner';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AdminService } from '@/services/admin/admin';
import { formatUsage } from '@/lib/format';
import type { AdminUser, UserQuotaResponse } from '@/services/admin/admin.types';
import { QUOTA_FIELDS, type QuotaText, defaultText, quotaPatch, quotaText } from '@/lib/quota-form';

export interface UserEditorProps {
  /** Opens a user from elsewhere ("Manage" in the user list); a new nonce reopens the same one. */
  openRequest?: { pubkey: string; nonce: number } | null;
  onDisableUser: (pubkey: string) => Promise<void>;
  onEnableUser: (pubkey: string) => Promise<void>;
  /** The homeserver has `GET /users/{pubkey}` (0.17+): status and storage used come from it. */
  hasUserRoutes?: boolean;
}

type Loaded = { pubkey: string; quota: UserQuotaResponse; text: QuotaText; usedBytes?: number };
/** What is known about the account being enabled: from the homeserver when it says, else from this session's own actions. */
type AccessState = 'enabled' | 'disabled' | 'unknown';

type Busy = 'lookup' | 'save' | 'disable' | 'enable' | null;

const getService = () => new AdminService();
const message = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;
const statusOf = (error: unknown) =>
  typeof error === 'object' && error !== null && 'status' in error ? (error as { status?: number }).status : undefined;

/** A pubky as typed or pasted, without the `pubky` prefix or the pubky:// scheme. */
const bareKey = (input: string) =>
  input
    .trim()
    .replace(/^pubky:\/\//, '')
    .replace(/^pubky(?=.{52}$)/, '');

/**
 * Look up one user by pubky, change their allowance (storage, rates, bursts,
 * writable paths) and disable or enable them. Uses the admin
 * `GET|PATCH /users/{pubkey}/quota`, and `GET /users/{pubkey}` where the
 * homeserver has it.
 */
export function UserEditor({ openRequest, onDisableUser, onEnableUser, hasUserRoutes = false }: UserEditorProps) {
  const [input, setInput] = useState('');
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [edited, setEdited] = useState<QuotaText | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [access, setAccess] = useState<AccessState>('unknown');
  const lookupId = useRef(0);
  // Whose status this session remembers; a different account starts from unknown.
  const rememberedFor = useRef<string | null>(null);

  /** Reads the account into the editor; false when it could not, with the reason shown. */
  const lookUp = useCallback(
    async (pubkey: string): Promise<boolean> => {
      const thisLookup = ++lookupId.current;
      setBusy('lookup');
      setError(null);
      setNotice(null);
      try {
        // Without the user routes only the limits are known: the quota route
        // does not say what the account stores or whether it is disabled.
        const user: Pick<AdminUser, 'quota'> & Partial<AdminUser> = hasUserRoutes
          ? await getService().getUser(pubkey)
          : { quota: await getService().getUserQuota(pubkey) };
        const { quota, used_bytes: usedBytes, disabled } = user;
        if (thisLookup !== lookupId.current) return false;
        const text = quotaText(quota.overrides);
        setLoaded({ pubkey, quota, text, usedBytes });
        setEdited(text);
        // The homeserver's word replaces what this session remembered, when it gives one.
        if (typeof disabled === 'boolean') setAccess(disabled ? 'disabled' : 'enabled');
        else if (rememberedFor.current !== pubkey) setAccess('unknown');
        rememberedFor.current = pubkey;
        return true;
      } catch (err) {
        if (thisLookup !== lookupId.current) return false;
        setLoaded(null);
        setError(
          statusOf(err) === 404
            ? 'This homeserver has no user with that pubky.'
            : statusOf(err) === 400
              ? 'That is not a valid pubky.'
              : message(err, 'Could not look up the user.'),
        );
        return false;
      } finally {
        if (thisLookup === lookupId.current) setBusy(null);
      }
    },
    [hasUserRoutes],
  );

  useEffect(() => {
    if (!openRequest) return;
    setInput(openRequest.pubkey);
    void lookUp(openRequest.pubkey);
  }, [openRequest, lookUp]);

  // Clearing the search bar clears the account with it: nothing of someone
  // else's stays on screen once their key is gone.
  const handleInput = (value: string) => {
    setInput(value);
    if (value.trim() === '' && loaded) {
      lookupId.current += 1;
      setLoaded(null);
      setEdited(null);
      setAccess('unknown');
      setError(null);
      setNotice(null);
    }
  };

  const handleLookUp = () => {
    const pubkey = bareKey(input);
    if (!pubkey) {
      setError("Enter a user's pubky first.");
      return;
    }
    setInput(pubkey);
    void lookUp(pubkey);
  };

  const handleSave = async () => {
    if (!loaded || !edited) return;
    setError(null);
    setNotice(null);
    let patch;
    try {
      patch = quotaPatch(loaded.text, edited);
    } catch (err) {
      setError(message(err, 'Could not read the changes.'));
      return;
    }
    setBusy('save');
    try {
      await getService().patchUserQuota(loaded.pubkey, patch);
      if (await lookUp(loaded.pubkey)) setNotice('Allowance saved.');
    } catch (err) {
      setError(message(err, 'Could not save the allowance.'));
    } finally {
      setBusy(null);
    }
  };

  const handleAccess = async (action: 'disable' | 'enable') => {
    if (!loaded) return;
    setBusy(action);
    setError(null);
    setNotice(null);
    try {
      await (action === 'disable' ? onDisableUser : onEnableUser)(loaded.pubkey);
      setAccess(action === 'disable' ? 'disabled' : 'enabled');
      // Read the account again so status and usage are the homeserver's, not this session's guess.
      if (hasUserRoutes && !(await lookUp(loaded.pubkey))) return;
      setNotice(
        action === 'disable'
          ? 'User disabled. They can no longer sign in or write; their files are kept.'
          : 'User enabled. They can sign in again.',
      );
    } catch (err) {
      setError(message(err, `Could not ${action} the user.`));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card data-testid="user-editor">
      <CardHeader className="pb-4">
        <CardTitle className="text-base sm:text-lg">Manage a user</CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          Look up an account by pubky to change its allowance, or to disable or enable it.
        </CardDescription>
      </CardHeader>

      <div className="mx-6 h-px bg-border/60" />

      <CardContent className="space-y-4 pt-4">
        <form
          className="flex flex-col gap-2 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            handleLookUp();
          }}
        >
          <Input
            aria-label="User pubky"
            placeholder="pubky…"
            value={input}
            onChange={(event) => handleInput(event.target.value)}
            // A request in flight is for the key shown; it cannot be typed over or cleared meanwhile.
            disabled={busy !== null}
            spellCheck={false}
            autoComplete="off"
            className="font-mono"
          />
          <Button type="submit" variant="outline" disabled={busy !== null} className="shrink-0 gap-2">
            {busy === 'lookup' ? <ButtonSpinner /> : <Search className="h-4 w-4" />}
            Look up
          </Button>
        </form>

        {error && (
          <Alert variant="destructive" data-testid="user-editor-error">
            <AlertTitle>Error</AlertTitle>
            <AlertDescription className="text-xs break-words">{error}</AlertDescription>
          </Alert>
        )}

        {notice && (
          <Alert data-testid="user-editor-notice">
            <Check className="h-4 w-4" />
            <AlertTitle>Done</AlertTitle>
            <AlertDescription className="text-xs">{notice}</AlertDescription>
          </Alert>
        )}

        {loaded && (
          <section className="space-y-3 border-t pt-4" data-testid="user-access">
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-foreground">Account</h3>
              <code className="block font-mono text-xs break-all text-muted-foreground sm:text-sm">
                pubky{loaded.pubkey}
              </code>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
              <span className="shrink-0 text-xs text-muted-foreground sm:text-sm">Status:</span>
              <AccessBadge access={access} />
            </div>
            {loaded.usedBytes !== undefined && (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                <span className="shrink-0 text-xs text-muted-foreground sm:text-sm">Storage used:</span>
                <span className="text-xs text-foreground sm:text-sm" data-testid="user-usage">
                  {formatUsage(loaded.usedBytes, loaded.quota.effective.storage_quota_mb)}
                </span>
              </div>
            )}
            {access === 'unknown' && (
              <p className="text-xs text-muted-foreground/70" data-testid="user-access-unknown">
                This homeserver does not report whether an account is disabled. After you disable or enable it here, the
                status shows what you did.
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {access !== 'enabled' && (
                <Button
                  variant="outline"
                  onClick={() => void handleAccess('enable')}
                  disabled={busy !== null}
                  size="sm"
                  data-testid="user-enable"
                >
                  {busy === 'enable' && <ButtonSpinner />}
                  Enable
                </Button>
              )}
              {access !== 'disabled' && (
                <Button
                  variant="destructive"
                  onClick={() => void handleAccess('disable')}
                  disabled={busy !== null}
                  size="sm"
                  data-testid="user-disable"
                >
                  {busy === 'disable' && <ButtonSpinner />}
                  Disable
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground/70">
              A disabled account cannot sign in or write; its files are kept and stay readable.
            </p>
          </section>
        )}

        {loaded && edited && (
          <section className="space-y-4 border-t pt-4" data-testid="user-editor-result">
            <div className="space-y-1">
              <h3 className="text-sm font-medium text-foreground">Allowance</h3>
              <p className="text-xs text-muted-foreground sm:text-sm">
                Empty fields follow the homeserver&apos;s defaults, shown greyed out. Clear a field to hand it back to
                the default.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {QUOTA_FIELDS.map(({ key, label, hint }) => {
                const overridden = key in loaded.quota.overrides;
                return (
                  <div key={key} className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <Label htmlFor={`quota-${key}`}>{label}</Label>
                      <Badge variant={overridden ? 'secondary' : 'outline'} className="text-[10px] font-normal">
                        {overridden ? 'custom' : 'default'}
                      </Badge>
                    </div>
                    <Input
                      id={`quota-${key}`}
                      value={edited[key]}
                      onChange={(event) => setEdited({ ...edited, [key]: event.target.value })}
                      placeholder={defaultText(key, loaded.quota.effective)}
                      spellCheck={false}
                      autoComplete="off"
                    />
                    <p className="text-xs text-muted-foreground/70">{hint}</p>
                  </div>
                );
              })}
            </div>

            <Button onClick={() => void handleSave()} disabled={busy !== null} size="sm">
              {busy === 'save' && <ButtonSpinner />}
              Save allowance
            </Button>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function AccessBadge({ access }: { access: AccessState }) {
  if (access === 'enabled') {
    return (
      <span
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-brand sm:text-sm"
        data-testid="user-access-enabled"
      >
        <CircleCheckBig className="h-4 w-4" />
        Enabled
      </span>
    );
  }
  if (access === 'disabled') {
    return (
      <Badge variant="destructive" className="text-xs" data-testid="user-access-disabled">
        <Ban className="mr-1 h-3 w-3" />
        Disabled
      </Badge>
    );
  }
  return (
    <span className="text-xs text-muted-foreground sm:text-sm" data-testid="user-access-not-known">
      Not known
    </span>
  );
}
