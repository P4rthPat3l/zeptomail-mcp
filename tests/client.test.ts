import assert from 'node:assert/strict';
import test from 'node:test';
import type { Config } from '../src/config.js';
import { ZeptoMailClient } from '../src/zeptomail-client.js';
import { ZohoOAuthTokenProvider } from '../src/zoho-oauth.js';

const config: Config = {
  clientId: 'client',
  clientSecret: 'secret',
  refreshToken: 'refresh',
  accountsUrl: 'https://accounts.zoho.com',
  apiBaseUrl: 'https://api.zeptomail.com/v1.1',
  allowWrites: true,
  allowedAgentKeys: undefined,
  transport: 'stdio',
  serverUrl: 'http://localhost:3006',
  port: 3006,
  tokenStorePath: '/tmp/zeptomail-test-tokens.json',
};

function oauthResponse() {
  return new Response(JSON.stringify({ access_token: 'token', expires_in: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

const agentsPayload = {
  data: [
    {
      mailagent_name: 'Acme Production',
      mailagent_key: 'prod-agent',
      description: 'Production transactional email',
      status: 'active',
    },
    {
      mailagent_name: 'Acme Staging',
      mailagent_key: 'staging-agent',
      description: 'Staging transactional email',
      status: 'active',
    },
  ],
  status: 'success',
};

test('listAgents obtains OAuth token and calls account-level Agents endpoint', async () => {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes('/oauth/v2/token')) return oauthResponse();
    return new Response(JSON.stringify(agentsPayload), { status: 200 });
  };

  const tokenProvider = new ZohoOAuthTokenProvider(config, mockFetch);
  const client = new ZeptoMailClient(config, tokenProvider, mockFetch);
  const agents = await client.listAgents();

  assert.equal(agents.length, 2);
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.url, 'https://api.zeptomail.com/v1.1/agents');
  const headers = new Headers(calls[1]!.init?.headers);
  assert.equal(headers.get('Authorization'), 'Zoho-oauthtoken token');
});

test('listTemplates calls the explicitly selected Agent endpoint', async () => {
  const calls: string[] = [];
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('/oauth/v2/token')) return oauthResponse();
    return new Response(JSON.stringify({ metadata: { count: 0 }, data: [], message: 'OK' }), {
      status: 200,
    });
  };

  const tokenProvider = new ZohoOAuthTokenProvider(config, mockFetch);
  const client = new ZeptoMailClient(config, tokenProvider, mockFetch);
  await client.listTemplates('prod-agent', 0, 10);

  assert.match(calls[1]!, /agents\/prod-agent\/templates\?offset=0&limit=10/);
});

test('findTemplates without agentKey searches Agents and returns owning Agent with each match', async () => {
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/oauth/v2/token')) return oauthResponse();
    if (url.endsWith('/v1.1/agents'))
      return new Response(JSON.stringify(agentsPayload), { status: 200 });
    if (url.includes('/agents/prod-agent/templates')) {
      return new Response(
        JSON.stringify({
          metadata: { offset: 0, count: 1, limit: 100 },
          data: [
            {
              template_key: 'key-prod',
              template_name: 'Team Invite',
              template_alias: 'team_invite',
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes('/agents/staging-agent/templates')) {
      return new Response(
        JSON.stringify({
          metadata: { offset: 0, count: 1, limit: 100 },
          data: [
            {
              template_key: 'key-stage',
              template_name: 'Team Invite',
              template_alias: 'team_invite',
            },
          ],
        }),
        { status: 200 },
      );
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  const tokenProvider = new ZohoOAuthTokenProvider(config, mockFetch);
  const client = new ZeptoMailClient(config, tokenProvider, mockFetch);
  const matches = await client.findTemplates('team_invite', 20);

  assert.equal(matches.length, 2);
  assert.equal(matches[0]!.agent.mailagent_name, 'Acme Production');
  assert.equal(matches[0]!.template.template_key, 'key-prod');
  assert.equal(matches[1]!.agent.mailagent_name, 'Acme Staging');
});

test('allowed Agent keys filter discovery and block direct access outside allowlist', async () => {
  const restrictedConfig: Config = { ...config, allowedAgentKeys: ['staging-agent'] };
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/oauth/v2/token')) return oauthResponse();
    if (url.endsWith('/v1.1/agents'))
      return new Response(JSON.stringify(agentsPayload), { status: 200 });
    throw new Error(`Unexpected URL: ${url}`);
  };

  const tokenProvider = new ZohoOAuthTokenProvider(restrictedConfig, mockFetch);
  const client = new ZeptoMailClient(restrictedConfig, tokenProvider, mockFetch);

  const agents = await client.listAgents();
  assert.deepEqual(
    agents.map((agent) => agent.mailagent_key),
    ['staging-agent'],
  );
  await assert.rejects(() => client.listTemplates('prod-agent'), /not allowed/);
});

test('partial update validates Agent name, fetches current template and preserves unspecified body', async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/oauth/v2/token')) return oauthResponse();
    requests.push({ url, init });
    if (url.endsWith('/v1.1/agents'))
      return new Response(JSON.stringify(agentsPayload), { status: 200 });
    if (init?.method === 'GET') {
      return new Response(
        JSON.stringify({
          data: {
            template_key: 'key1',
            template_name: 'Invite',
            template_alias: 'team_invite',
            subject: 'Old subject',
            htmlbody: '<p>Hello {{name}}</p>',
            modified_time: '24 Aug 2026 10:00 AM',
          },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ message: 'OK', data: [] }), { status: 200 });
  };

  const tokenProvider = new ZohoOAuthTokenProvider(config, mockFetch);
  const client = new ZeptoMailClient(config, tokenProvider, mockFetch);
  await client.updateTemplate('prod-agent', 'key1', 'Acme Production', {
    subject: 'New subject',
    expectedModifiedTime: '24 Aug 2026 10:00 AM',
  });

  assert.equal(requests.length, 3);
  assert.equal(requests[2]!.init?.method, 'PUT');
  assert.match(requests[2]!.url, /agents\/prod-agent\/templates\/key1$/);
  const body = JSON.parse(String(requests[2]!.init?.body));
  assert.equal(body.template_name, 'Invite');
  assert.equal(body.template_alias, 'team_invite');
  assert.equal(body.subject, 'New subject');
  assert.equal(body.htmlbody, '<p>Hello {{name}}</p>');
});

test('update refuses wrong expected Agent name before touching the template', async () => {
  let templateTouched = false;
  const mockFetch: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes('/oauth/v2/token')) return oauthResponse();
    if (url.endsWith('/v1.1/agents'))
      return new Response(JSON.stringify(agentsPayload), { status: 200 });
    if (url.includes('/templates/')) templateTouched = true;
    return new Response('{}', { status: 200 });
  };

  const tokenProvider = new ZohoOAuthTokenProvider(config, mockFetch);
  const client = new ZeptoMailClient(config, tokenProvider, mockFetch);
  await assert.rejects(
    () =>
      client.updateTemplate('prod-agent', 'key1', 'Acme Staging', {
        subject: 'x',
        expectedModifiedTime: 'old-time',
      }),
    /Agent-name safety check failed/,
  );
  assert.equal(templateTouched, false);
});

test('update refuses stale expectedModifiedTime', async () => {
  const mockFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes('/oauth/v2/token')) return oauthResponse();
    if (url.endsWith('/v1.1/agents'))
      return new Response(JSON.stringify(agentsPayload), { status: 200 });
    if (init?.method === 'GET') {
      return new Response(
        JSON.stringify({
          data: {
            template_key: 'key1',
            template_name: 'Invite',
            subject: 'Subject',
            htmlbody: '<p>Hi</p>',
            modified_time: 'new-time',
          },
        }),
        { status: 200 },
      );
    }
    throw new Error('PUT should not happen');
  };

  const tokenProvider = new ZohoOAuthTokenProvider(config, mockFetch);
  const client = new ZeptoMailClient(config, tokenProvider, mockFetch);
  await assert.rejects(
    () =>
      client.updateTemplate('prod-agent', 'key1', 'Acme Production', {
        subject: 'x',
        expectedModifiedTime: 'old-time',
      }),
    /Template changed since it was read/,
  );
});
