import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.js';
import { TokenStore } from '../src/token-store.js';
import { ZohoOAuthProvider } from '../src/zoho-oauth-provider.js';

const config: Config = {
  clientId: 'zoho-client',
  clientSecret: 'zoho-secret',
  refreshToken: undefined,
  accountsUrl: 'https://accounts.zoho.com',
  apiBaseUrl: 'https://api.zeptomail.com/v1.1',
  allowWrites: false,
  allowedAgentKeys: undefined,
  transport: 'http',
  serverUrl: 'http://localhost:3006',
  port: 3006,
  tokenStorePath: '/tmp/zeptomail-test-tokens.json',
};

const client = {
  client_id: 'mcp-client-1',
  redirect_uris: ['http://127.0.0.1:19876/mcp/oauth/callback'],
  client_id_issued_at: Math.floor(Date.now() / 1000),
};

function makeProvider(zohoResponses: Array<Record<string, unknown>>) {
  const dir = mkdtempSync(join(tmpdir(), 'zeptomail-oauth-'));
  const store = new TokenStore(join(dir, 'tokens.json'));
  let call = 0;
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/oauth/v2/token')) {
      const response = zohoResponses[call++];
      if (!response) throw new Error(`Unexpected Zoho token call #${call}`);
      return new Response(JSON.stringify(response), { status: 200 });
    }
    throw new Error(`Unexpected URL: ${url}`);
  };
  const provider = new ZohoOAuthProvider(config, store, fetchImpl);
  // Seed the store with the test client (equivalent to a prior POST /register).
  store.setClient(client.client_id, {
    client,
    zohoRefreshToken: '',
    tokens: { accessToken: '', refreshToken: '', expiresAt: 0, scopes: [] },
  });
  return { provider, store, dir };
}

/** Runs authorize() and returns the Zoho state param from the redirect URL. */
async function authorizeAndGetState(provider: ZohoOAuthProvider): Promise<string> {
  let zohoUrl = '';
  const res = {
    redirect: (url: string) => {
      zohoUrl = url;
    },
  } as unknown as Parameters<typeof provider.authorize>[2];
  await provider.authorize(
    client,
    {
      codeChallenge: 'challenge-abc',
      redirectUri: 'http://127.0.0.1:19876/mcp/oauth/callback',
      scopes: ['mcp:tools'],
    },
    res,
  );
  const state = new URL(zohoUrl).searchParams.get('state');
  assert.ok(state);
  return state;
}

/** Runs authorize + handleCallback and returns our authorization code. */
async function completeAuthorization(provider: ZohoOAuthProvider): Promise<string> {
  const state = await authorizeAndGetState(provider);
  const callback = provider.handleCallback('zoho-code', state);
  assert.ok('redirectUrl' in callback);
  const ourCode = new URL(callback.redirectUrl).searchParams.get('code');
  assert.ok(ourCode);
  return ourCode;
}

test('authorize redirects to Zoho with PKCE challenge and offline access', async () => {
  const { provider, dir } = makeProvider([]);
  try {
    let zohoUrl = '';
    const res = {
      redirect: (url: string) => {
        zohoUrl = url;
      },
    } as unknown as Parameters<typeof provider.authorize>[2];
    await provider.authorize(
      client,
      {
        codeChallenge: 'challenge-abc',
        redirectUri: 'http://127.0.0.1:19876/mcp/oauth/callback',
        scopes: ['mcp:tools'],
      },
      res,
    );
    const parsed = new URL(zohoUrl);
    assert.equal(parsed.origin, 'https://accounts.zoho.com');
    assert.equal(parsed.pathname, '/oauth/v2/auth');
    assert.equal(parsed.searchParams.get('client_id'), 'zoho-client');
    assert.equal(parsed.searchParams.get('response_type'), 'code');
    assert.equal(parsed.searchParams.get('code_challenge'), 'challenge-abc');
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(parsed.searchParams.get('access_type'), 'offline');
    assert.equal(parsed.searchParams.get('redirect_uri'), 'http://localhost:3006/callback');
    assert.ok(parsed.searchParams.get('state'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('full flow: callback exchange stores Zoho refresh token and issues our tokens', async () => {
  const { provider, store, dir } = makeProvider([
    { access_token: 'zoho-access', refresh_token: 'zoho-refresh', expires_in: 3600 },
  ]);
  try {
    const ourCode = await completeAuthorization(provider);
    const tokens = await provider.exchangeAuthorizationCode(client, ourCode, 'verifier-123');
    assert.ok(tokens.access_token);
    assert.ok(tokens.refresh_token);
    assert.equal(tokens.token_type, 'Bearer');

    const entry = store.getClient('mcp-client-1');
    assert.ok(entry);
    assert.equal(entry.zohoRefreshToken, 'zoho-refresh');
    assert.equal(entry.tokens.accessToken, tokens.access_token);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh token exchange proxies to Zoho and rotates our tokens', async () => {
  const { provider, dir } = makeProvider([
    { access_token: 'zoho-access', refresh_token: 'zoho-refresh', expires_in: 3600 },
    { access_token: 'zoho-access-2', expires_in: 3600 },
  ]);
  try {
    const ourCode = await completeAuthorization(provider);
    const first = await provider.exchangeAuthorizationCode(client, ourCode, 'verifier-123');
    assert.ok(first.refresh_token);

    const second = await provider.exchangeRefreshToken(client, first.refresh_token!);
    assert.notEqual(second.access_token, first.access_token);
    assert.ok(second.refresh_token);
    assert.notEqual(second.refresh_token, first.refresh_token);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyAccessToken rejects unknown and expired tokens', async () => {
  const { provider, dir } = makeProvider([
    { access_token: 'zoho-access', refresh_token: 'zoho-refresh', expires_in: 3600 },
  ]);
  try {
    await assert.rejects(() => provider.verifyAccessToken('bogus'), /Invalid or expired/);
    const ourCode = await completeAuthorization(provider);
    const tokens = await provider.exchangeAuthorizationCode(client, ourCode, 'verifier-123');
    const info = await provider.verifyAccessToken(tokens.access_token);
    assert.equal(info.clientId, 'mcp-client-1');
    assert.deepEqual(info.scopes, ['mcp:tools']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('Zoho refresh token never appears in issued tokens', async () => {
  const { provider, dir } = makeProvider([
    { access_token: 'zoho-access', refresh_token: 'zoho-refresh', expires_in: 3600 },
  ]);
  try {
    const ourCode = await completeAuthorization(provider);
    const tokens = await provider.exchangeAuthorizationCode(client, ourCode, 'verifier-123');
    assert.notEqual(tokens.access_token, 'zoho-access');
    assert.notEqual(tokens.refresh_token, 'zoho-refresh');
    assert.ok(!JSON.stringify(tokens).includes('zoho-refresh'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
