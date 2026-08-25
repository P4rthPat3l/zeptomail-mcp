import type { Config } from './config.js';
import type { TokenProvider } from './zeptomail-client.js';

type FetchLike = typeof fetch;

interface ZohoRefreshResponse {
  access_token?: string;
  expires_in?: number;
  token_type?: string;
  api_domain?: string;
  error?: string;
}

export class ZohoOAuthTokenProvider implements TokenProvider {
  private accessToken: string | undefined;
  private expiresAt = 0;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  invalidate(): void {
    this.accessToken = undefined;
    this.expiresAt = 0;
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.expiresAt - 60_000) return this.accessToken;

    if (!this.config.refreshToken) {
      throw new Error(
        'ZOHO_REFRESH_TOKEN is required in stdio mode. In HTTP mode, users authorize via OAuth.',
      );
    }

    const body = new URLSearchParams({
      refresh_token: this.config.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
    });

    const response = await this.fetchImpl(`${this.config.accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    const payload = (await response.json()) as ZohoRefreshResponse;
    if (!response.ok || !payload.access_token) {
      const reason = payload.error || `HTTP ${response.status}`;
      throw new Error(`Failed to refresh Zoho OAuth access token: ${reason}`);
    }

    this.accessToken = payload.access_token;
    const expiresInSeconds = Math.max(60, payload.expires_in ?? 3600);
    this.expiresAt = now + expiresInSeconds * 1000;
    return this.accessToken;
  }
}

/**
 * Token provider for HTTP mode: resolves the Zoho refresh token from the
 * per-client token store (obtained during that client's OAuth consent) and
 * mints a fresh Zoho access token for it.
 */
export class PerClientZohoTokenProvider implements TokenProvider {
  private accessToken: string | undefined;
  private expiresAt = 0;

  constructor(
    private readonly config: Config,
    private readonly getZohoRefreshToken: () => string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  invalidate(): void {
    this.accessToken = undefined;
    this.expiresAt = 0;
  }

  async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && now < this.expiresAt - 60_000) return this.accessToken;

    const refreshToken = this.getZohoRefreshToken();
    if (!refreshToken) throw new Error('No Zoho refresh token for this client. Re-authorize.');

    const body = new URLSearchParams({
      refresh_token: refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
    });

    const response = await this.fetchImpl(`${this.config.accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

    const payload = (await response.json()) as ZohoRefreshResponse;
    if (!response.ok || !payload.access_token) {
      const reason = payload.error || `HTTP ${response.status}`;
      throw new Error(`Failed to refresh Zoho OAuth access token: ${reason}`);
    }

    this.accessToken = payload.access_token;
    const expiresInSeconds = Math.max(60, payload.expires_in ?? 3600);
    this.expiresAt = now + expiresInSeconds * 1000;
    return this.accessToken;
  }
}
