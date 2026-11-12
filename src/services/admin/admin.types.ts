export type AdminInfoResponse = {
  num_users: number;
  num_disabled_users: number;
  total_disk_used_mb: number;
  num_signup_codes: number;
  num_unused_signup_codes: number;
  public_key?: string;
  pkarr_pubky_address?: string;
  pkarr_icann_domain?: string;
  version?: string;
  // Legacy field for backward compatibility
  pubkey?: string;
};

export type DeleteUrlRequest = { path: string };
export type DisableUserRequest = { pubkey: string };
export type GenerateInviteResponse = { token: string };

/** Admin `GET /signup_tokens`. Timestamps are UTC without a zone. */
export type SignupTokenState = 'unused' | 'used';
export type SignupToken = {
  token: string;
  created_at: string;
  used_at: string | null;
  used_by: string | null;
  /** The limits the code carries, as given when it was created; empty = the homeserver's defaults. Reported by homeserver 0.17+. */
  quota?: UserQuota;
};
export type SignupTokensResponse = {
  items: SignupToken[];
  next_cursor: string | null;
};

/**
 * The limits an account can have: given to an invite with
 * `POST /generate_signup_token`, read and changed per user with
 * `GET|PATCH /users/{pubkey}/quota`, and set as the homeserver's defaults in
 * its config. A missing field means the homeserver default.
 */
export type UserQuota = {
  storage_quota_mb?: number | 'unlimited';
  rate_read?: string;
  rate_write?: string;
  rate_read_burst?: number;
  rate_write_burst?: number;
  /** Missing = writes anywhere; [] = read-only. */
  allowed_write_paths?: string[];
};

/**
 * A user's limits: `overrides` has only what was set for this user, `effective`
 * is what applies once the homeserver's defaults fill the rest, leaving out a
 * field that resolves to no limit.
 */
export type UserQuotaResponse = {
  effective: UserQuota;
  overrides: UserQuota;
};
/** Fields sent are changed; null hands a field back to the homeserver default. */
export type UserQuotaPatch = { [K in keyof UserQuota]?: UserQuota[K] | null };

export type UserListState = 'all' | 'enabled' | 'disabled';
export type UserSort = 'created_at' | 'used_bytes';

/** An account as admin `GET /users` and `GET /users/{pubkey}` report it (homeserver 0.17+), with usage and limits. */
export type AdminUser = {
  /** The account's key, z-base-32 as the homeserver names it. */
  pubky: string;
  /** When the account was created: UTC without a zone. */
  created_at: string;
  disabled: boolean;
  used_bytes: number;
  quota: UserQuotaResponse;
};
export type UsersResponse = {
  items: AdminUser[];
  next_cursor: string | null;
};
export type UsersQuery = {
  state?: UserListState;
  sortBy?: UserSort;
  reverse?: boolean;
  limit?: number;
  cursor?: string;
};
