# ZeptoMail Multi-Agent Templates MCP — Implementation Handoff

## Goal

Give Proposal.biz AI coding/operations agents controlled access to templates across all ZeptoMail Agents in the account, while making the target Agent explicit and preventing accidental production edits.

## Recommended repo placement

```text
tools/zeptomail-mcp/
```

Keep the package independent from the Proposal.biz application runtime. The MCP host launches it locally over stdio.

## V0.3 boundary

Included:

- list all accessible ZeptoMail Agents
- optional server-side Agent allowlist
- list templates in a selected Agent
- search templates in one Agent or across all Agents
- fetch a full template from a selected Agent
- create/update/delete templates in an explicit Agent
- automatic Zoho OAuth access-token refresh
- global write kill switch
- Agent-name confirmation on every write
- stale-write protection on update/delete
- **OAuth 2.0 authorization code flow with PKCE (HTTP transport)** — the server acts as an OAuth authorization server proxying to Zoho as the upstream AS; per-client Zoho refresh tokens stored server-side, never exposed to clients

Not included:

- email sending
- Send Mail Token/API-key access
- Agent creation/editing
- SMTP short-password management
- domain management
- suppression management
- email logs
- multi-tenant/user-facing OAuth (each MCP client gets its own consent + token)

## Required OAuth scopes

Full template manager:

```text
Zeptomail.MailAgents.READ
Zeptomail.MailTemplates.All
```

Read-only reviewer:

```text
Zeptomail.MailAgents.READ
Zeptomail.MailTemplates.READ
```

If the v0.1 refresh token only has MailTemplates scopes, add `Zeptomail.MailAgents.READ` using Zoho OAuth incremental scope enhancement, or create/authorize a new grant containing that scope. An existing refresh token does not gain the permission merely by being refreshed.

## Required secrets

```text
ZOHO_CLIENT_ID
ZOHO_CLIENT_SECRET
ZOHO_ACCOUNTS_URL
```

`ZOHO_REFRESH_TOKEN` is required only in stdio mode. In HTTP mode it is optional: each MCP client authorizes through the browser and the server stores a per-client Zoho refresh token in the token store.

Optional:

```text
ZEPTOMAIL_API_BASE_URL
ZEPTOMAIL_MCP_ALLOWED_AGENT_KEYS
ZEPTOMAIL_MCP_ALLOW_WRITES
ZEPTOMAIL_MCP_TRANSPORT        # stdio (default) | http
ZEPTOMAIL_MCP_SERVER_URL       # default http://localhost:3006
ZEPTOMAIL_MCP_PORT             # default 3006
ZEPTOMAIL_MCP_TOKEN_STORE      # default mcp-tokens.json
```

`ZEPTOMAIL_AGENT_ALIAS` from v0.1 is removed.

## OAuth 2.0 + PKCE (HTTP mode, v0.3)

The server implements the MCP OAuth authorization spec (2025-06-18) as an authorization server that proxies to Zoho as the upstream AS:

1. Client fetches `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`.
2. Client dynamically registers (`POST /register`) — the SDK generates the client_id.
3. Client opens `/authorize` with a PKCE S256 challenge; the server redirects to Zoho with the same challenge plus `access_type=offline`.
4. Zoho redirects to `<server-url>/callback`; the server stores the pending authorization, redirects the client's browser back to the client's loopback URI with its own one-time code.
5. Client exchanges the code at `/token`; the server forwards the code + code_verifier to Zoho's token endpoint (with the server's Zoho client secret), stores the Zoho refresh token per client, and issues its own access/refresh tokens.
6. Refresh: client calls `/token` with its refresh token; the server proxies to Zoho and rotates its own tokens.

Key properties:

- `skipLocalPkceValidation: true` — the code_verifier passes through to Zoho, which performs the real PKCE validation.
- The Zoho refresh token is stored per MCP client in `ZEPTOMAIL_MCP_TOKEN_STORE` (0600) and never returned to any client.
- Our access tokens are opaque UUIDs validated in-memory (`verifyAccessToken`); restarting the server invalidates them (clients re-auth or refresh).
- The SDK rejects non-HTTPS issuer URLs except localhost; production must run behind HTTPS with `ZEPTOMAIL_MCP_SERVER_URL` set to the public HTTPS URL.
- Zoho requires the callback redirect URI to be registered in the Zoho API console. For local dev, register `http://localhost:3006/callback`; for production, the public HTTPS callback.

## Safety model

1. Agent discovery is read-only (`GET /v1.1/agents`).
2. `ZEPTOMAIL_MCP_ALLOW_WRITES=false` by default.
3. Every create/update/delete call requires `confirm=true`.
4. Every mutation requires both `agentKey` and `expectedAgentName` from a recent Agent listing.
5. The client re-lists Agents before mutation and rejects a key/name mismatch.
6. Update requires `expectedModifiedTime` from a fresh get call.
7. Delete requires `expectedTemplateName` plus `expectedModifiedTime`.
8. Update/delete are marked destructive in MCP annotations so compatible hosts can surface approval.
9. `ZEPTOMAIL_MCP_ALLOWED_AGENT_KEYS` can constrain the MCP to a safe subset even when OAuth can access the whole account.
10. No OAuth secret/access token or Send Mail Token is ever returned through an MCP tool.
11. In HTTP mode, the Zoho refresh token never leaves the server; clients only ever hold the server's own tokens.

## Expected editing workflow

Example: "Update `team_invite` in Proposal.biz Production."

1. `zeptomail_list_agents({})`
2. Select `{ mailagent_name: "Proposal.biz Production", mailagent_key: "..." }`.
3. `zeptomail_find_templates({ agentKey, query: "team_invite" })`
4. `zeptomail_get_template({ agentKey, templateKey })`
5. Review subject/body/merge variables and `modified_time`.
6. Draft the change while preserving required merge variables.
7. Human/host approval.
8. `zeptomail_update_template({ agentKey, expectedAgentName, templateKey, expectedModifiedTime, ..., confirm: true })`
9. `zeptomail_get_template(...)` and verify.

If the request does not identify an Agent and the same template alias exists in multiple Agents, the AI should not choose one implicitly. It should surface the matches and require explicit environment selection before mutation.

## Verification before production writes

```bash
npm install
npm run typecheck
npm test
npm run build
npx @modelcontextprotocol/inspector node ./dist/src/server.js
```

Then verify in this order:

1. `zeptomail_list_agents` with writes disabled.
2. Confirm all expected Production/Staging/etc. Agents are visible.
3. Search `team_invite` across all Agents and confirm results carry the correct Agent.
4. Fetch a template from Staging.
5. Enable writes.
6. Create a disposable template in a sandbox/Staging Agent.
7. Update it.
8. Attempt an update with the wrong `expectedAgentName` and confirm rejection.
9. Attempt an update with stale `expectedModifiedTime` and confirm rejection.
10. Delete the disposable template.
11. Only then allow production template changes.

## Deployment choice

Keep stdio for the internal AI-agent use case. For public publishing, run the HTTP transport (`ZEPTOMAIL_MCP_TRANSPORT=http`) behind HTTPS with OAuth 2.0 + PKCE; the server is its own authorization server proxying to Zoho, so no separate auth service is needed. The token store is a single JSON file — for multi-instance production, swap `TokenStore` for a shared store (SQLite/Postgres) before scaling horizontally.
