import {
  AdminInfoResponse,
  AdminUser,
  DeleteUrlRequest,
  DisableUserRequest,
  GenerateInviteResponse,
  SignupTokenState,
  SignupTokensResponse,
  UserQuota,
  UserQuotaPatch,
  UserQuotaResponse,
  UsersQuery,
  UsersResponse,
} from './admin.types';

/**
 * All requests go through the dashboard's same-origin proxy; the admin token
 * is attached server-side by the API route.
 */
export class AdminService {
  private baseUrl = '/api/admin';

  private createHttpError(message: string, status: number): Error & { status: number } {
    const error = new Error(message) as Error & { status: number };
    error.status = status;
    return error;
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await this.send(path, init);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /**
   * Resolves with any 2xx response and leaves its body unread; throws on anything else.
   * For calls the homeserver answers without JSON: disable/enable reply with a plain-text "Ok",
   * a quota PATCH with an empty body.
   */
  private async send(path: string, init?: RequestInit): Promise<Response> {
    // Always use API route - no need to check baseUrl
    try {
      const headers = new Headers(init?.headers);
      if (!headers.has('content-type')) {
        headers.set('content-type', 'application/json');
      }
      // Don't set X-Admin-Password - API route handles it server-side

      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers,
        cache: 'no-store',
      });

      if (!res.ok) {
        const contentType = res.headers.get('content-type');
        let message = `Request failed: ${res.status}`;

        if (contentType?.includes('application/json')) {
          try {
            const json = await res.json();
            message = json.message || json.error || message;
          } catch {
            // Fall through to text parsing
          }
        } else {
          const text = await res.text();
          // Don't show HTML error pages, just status
          if (!text.includes('<!DOCTYPE') && !text.includes('<html')) {
            message = text || message;
          }
        }

        throw this.createHttpError(message, res.status);
      }

      return res;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error('Network error: Failed to connect to homeserver');
    }
  }

  async getInfo(): Promise<AdminInfoResponse> {
    return this.request<AdminInfoResponse>('/info');
  }

  /** The homeserver's accounts, a page at a time (0.17+). */
  async getUsers(query: UsersQuery): Promise<UsersResponse> {
    const params = new URLSearchParams();
    if (query.state) params.set('state', query.state);
    if (query.sortBy) params.set('sort_by', query.sortBy);
    if (query.reverse) params.set('reverse', 'true');
    if (query.limit) params.set('limit', String(query.limit));
    if (query.cursor) params.set('cursor', query.cursor);
    return this.request<UsersResponse>(`/users?${params.toString()}`);
  }

  /** One account with its usage, status and limits (0.17+); 404 for an unknown pubky. */
  async getUser(pubkey: string): Promise<AdminUser> {
    return this.request<AdminUser>(`/users/${encodeURIComponent(pubkey)}`);
  }

  async getUserQuota(pubkey: string): Promise<UserQuotaResponse> {
    return this.request<UserQuotaResponse>(`/users/${encodeURIComponent(pubkey)}/quota`);
  }

  /** Changes the fields in `patch`; a null field goes back to the homeserver default. */
  async patchUserQuota(pubkey: string, patch: UserQuotaPatch): Promise<void> {
    await this.send(`/users/${encodeURIComponent(pubkey)}/quota`, { method: 'PATCH', body: JSON.stringify(patch) });
  }

  /** The homeserver's invite codes in `state`, a page at a time, in the homeserver's order (by code). */
  async getSignupTokens(state: SignupTokenState, limit = 50, cursor?: string): Promise<SignupTokensResponse> {
    const params = new URLSearchParams({ state, limit: String(limit) });
    if (cursor) params.set('cursor', cursor);
    return this.request<SignupTokensResponse>(`/signup_tokens?${params.toString()}`);
  }

  /** A new invite code; with `limits`, one whose user gets those limits instead of the homeserver's defaults. */
  async generateInvite(limits?: UserQuota): Promise<GenerateInviteResponse> {
    // Its own API route, which turns the homeserver's plain-text code into JSON.
    const withLimits = limits !== undefined && Object.keys(limits).length > 0;
    const res = await fetch(`${this.baseUrl}/generate_signup_token`, {
      cache: 'no-store',
      ...(withLimits
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(limits) }
        : {}),
    });
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: `Failed to generate invite: ${res.status}` }));
      throw new Error(error.error || `Failed to generate invite: ${res.status}`);
    }
    const data = await res.json();
    return { token: data.token };
  }

  async disableUser(payload: DisableUserRequest): Promise<void> {
    await this.send(`/users/${payload.pubkey}/disable`, { method: 'POST' });
  }

  async enableUser(payload: DisableUserRequest): Promise<void> {
    await this.send(`/users/${payload.pubkey}/enable`, { method: 'POST' });
  }

  async deleteUrl(payload: DeleteUrlRequest): Promise<void> {
    await this.request(`/webdav/${payload.path}`, { method: 'DELETE' });
  }
}
