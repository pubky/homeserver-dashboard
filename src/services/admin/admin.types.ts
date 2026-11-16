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
export type DisabledUser = { pubkey: string };
export type DisabledUsersResponse = {
  items: DisabledUser[];
  next_cursor: string | null;
};
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
 * The limits an account can have: given to an invite
 * with `POST /generate_signup_token`, and set as the homeserver's defaults in
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
