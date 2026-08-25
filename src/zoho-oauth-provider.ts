import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { Config } from './config.js';
import { TokenStore, type StoredClientTokens } from './token-store.js';

const ZOHO_SCOPES = 'Zeptomail.MailAgents.READ Zeptomail.MailTemplates.All';
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface PendingAuthorization {
  clientId: string;
  clientState: string | undefined;
  clientRedirectUri: string;
  codeChallenge: string;
  scopes: string[];
  zohoCode?: string;
}

interface IssuedToken {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  type: 'access' | 'refresh';
}

/**
 * OAuth authorization server that proxies to Zoho as the upstream
 * authorization server. The MCP client's PKCE challenge is passed through to
 * Zoho (skipLocalPkceValidation), and the Zoho refresh token obtained during
 * consent is stored per MCP client and never leaves the server.
 */
export class ZohoOAuthProvider implements OAuthServerProvider {
  readonly skipLocalPkceValidation = true;
  readonly clientsStore: OAuthRegisteredClientsStore;
  private pending = new Map<string, PendingAuthorization>();
  private issued = new Map<string, IssuedToken>();

  constructor(
    private readonly config: Config,
    private readonly store: TokenStore,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.clientsStore = {
      getClient: async (clientId) => this.store.getClient(clientId)?.client,
      registerClient: async (metadata) => {
        const client: OAuthClientInformationFull = {
          ...metadata,
          client_id: randomUUID(),
          client_id_issued_at: Math.floor(Date.now() / 1000),
        };
        this.store.setClient(client.client_id, {
          client,
          zohoRefreshToken: '',
          tokens: { accessToken: '', refreshToken: '', expiresAt: 0, scopes: [] },
        });
        return client;
      },
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const state = randomUUID();
    this.pending.set(state, {
      clientId: client.client_id,
      clientState: params.state,
      clientRedirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scopes: params.scopes ?? [],
    });

    const authUrl = new URL(`${this.config.accountsUrl}/oauth/v2/auth`);
    authUrl.searchParams.set('client_id', this.config.clientId);
    authUrl.searchParams.set('response_type', 'code');
    authUrl.searchParams.set('redirect_uri', this.callbackUrl());
    authUrl.searchParams.set('scope', ZOHO_SCOPES);
    authUrl.searchParams.set('code_challenge', params.codeChallenge);
    authUrl.searchParams.set('code_challenge_method', 'S256');
    authUrl.searchParams.set('access_type', 'offline');
    authUrl.searchParams.set('state', state);
    res.redirect(authUrl.toString());
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const pending = this.pending.get(authorizationCode);
    if (!pending || pending.clientId !== client.client_id)
      throw new Error('Invalid authorization code');
    return pending.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    codeVerifier?: string,
  ): Promise<OAuthTokens> {
    const pending = this.pending.get(authorizationCode);
    if (!pending || pending.clientId !== client.client_id)
      throw new Error('Invalid authorization code');
    if (!pending.zohoCode) throw new Error('Missing Zoho authorization code');
    if (!codeVerifier) throw new Error('Missing code_verifier');
    this.pending.delete(authorizationCode);

    const zohoTokens = await this.exchangeZohoCode(pending.zohoCode, codeVerifier);
    if (!zohoTokens.refresh_token) throw new Error('Zoho did not return a refresh token');

    const entry = this.store.getClient(client.client_id);
    if (!entry) throw new Error('Client not found');
    entry.zohoRefreshToken = zohoTokens.refresh_token;
    entry.tokens = this.issueTokens(client.client_id, pending.scopes);
    this.store.setClient(client.client_id, entry);
    return this.toOAuthTokens(entry.tokens);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    const entry = this.store.getClient(client.client_id);
    if (!entry) throw new Error('Client not found');
    const issued = this.issued.get(refreshToken);
    if (!issued || issued.clientId !== client.client_id || issued.type !== 'refresh') {
      throw new Error('Invalid refresh token');
    }
    if (issued.expiresAt < Date.now()) throw new Error('Refresh token expired');
    if (!entry.zohoRefreshToken) throw new Error('No Zoho refresh token for this client');

    entry.tokens = this.issueTokens(client.client_id, scopes ?? entry.tokens.scopes);
    this.store.setClient(client.client_id, entry);
    return this.toOAuthTokens(entry.tokens);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const data = this.issued.get(token);
    if (!data || data.type !== 'access' || data.expiresAt < Date.now()) {
      throw new Error('Invalid or expired token');
    }
    return {
      token,
      clientId: data.clientId,
      scopes: data.scopes,
      expiresAt: Math.floor(data.expiresAt / 1000),
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    for (const [token, data] of this.issued) {
      if (
        data.clientId === client.client_id &&
        (token === request.token || data.type === 'refresh')
      ) {
        this.issued.delete(token);
      }
    }
  }

  /** Handles the Zoho redirect back to /callback. Returns the URL to redirect the MCP client to. */
  handleCallback(code: string, state: string): { redirectUrl: string } | { error: string } {
    const pending = this.pending.get(state);
    if (!pending) return { error: 'Invalid state parameter' };
    pending.zohoCode = code;
    const ourCode = randomUUID();
    this.pending.set(ourCode, pending);
    this.pending.delete(state);

    const target = new URL(pending.clientRedirectUri);
    target.searchParams.set('code', ourCode);
    if (pending.clientState) target.searchParams.set('state', pending.clientState);
    return { redirectUrl: target.toString() };
  }

  callbackUrl(): string {
    return `${this.config.serverUrl}/callback`;
  }

  private async exchangeZohoCode(
    code: string,
    codeVerifier: string,
  ): Promise<{ access_token: string; refresh_token?: string }> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: this.callbackUrl(),
      code_verifier: codeVerifier,
    });
    const response = await this.fetchImpl(`${this.config.accountsUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const payload = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
    };
    if (!response.ok || !payload.access_token) {
      throw new Error(`Zoho token exchange failed: ${payload.error ?? `HTTP ${response.status}`}`);
    }
    return {
      access_token: payload.access_token,
      ...(payload.refresh_token ? { refresh_token: payload.refresh_token } : {}),
    };
  }

  private issueTokens(clientId: string, scopes: string[]): StoredClientTokens {
    const accessToken = randomUUID();
    const refreshToken = randomUUID();
    this.issued.set(accessToken, {
      clientId,
      scopes,
      expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS,
      type: 'access',
    });
    this.issued.set(refreshToken, {
      clientId,
      scopes,
      expiresAt: Date.now() + REFRESH_TOKEN_TTL_MS,
      type: 'refresh',
    });
    return { accessToken, refreshToken, expiresAt: Date.now() + ACCESS_TOKEN_TTL_MS, scopes };
  }

  private toOAuthTokens(tokens: StoredClientTokens): OAuthTokens {
    return {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      token_type: 'Bearer',
      expires_in: Math.max(1, Math.floor((tokens.expiresAt - Date.now()) / 1000)),
      scope: tokens.scopes.join(' '),
    };
  }
}
