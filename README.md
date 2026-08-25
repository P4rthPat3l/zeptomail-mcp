# ZeptoMail Templates MCP

An MCP server that lets an AI agent (opencode, Claude Desktop, Cursor, ...) inspect and manage email templates across **all ZeptoMail Agents in your Zoho account**.

It intentionally does **not** send email, create/delete Agents, expose Send Mail Tokens, or manage domains. It only reads the Agent list and manages templates.

## Quickstart (local, ~5 minutes)

### 1. Install the server

```bash
npm i -g zeptomail-mcp
```

This gives you a `zeptomail-mcp` command on your PATH. Skip this if you'd rather run from a local clone of [the repo](https://github.com/P4rthPat3l/zeptomail-mcp) (`node /path/to/zeptomail-mcp/dist/src/server.js`).

### 2. Create a Zoho OAuth app

1. Open the [Zoho API Console](https://api-console.zoho.com/).
2. Create a **Server-based Application**:
   - Client name: `zeptomailmcp` (no hyphens — Zoho rejects them)
   - Homepage URL: anything, e.g. `https://github.com/P4rthPat3l/zeptomail-mcp`
   - **Authorized redirect URI: `http://localhost:4567/callback`**
3. Note the **Client ID** and **Client Secret**.

> A Self Client also works. It has no redirect URI field, so instead of step 2 use its **Generate Code** tab (see _Self Client setup_ below).

### 3. Get a refresh token

```bash
ZOHO_CLIENT_ID=<your-client-id> ZOHO_CLIENT_SECRET=<your-secret> zeptomail-mcp-login
```

Your browser opens Zoho's consent screen for scopes `Zeptomail.MailAgents.READ` + `Zeptomail.MailTemplates.All`. After you approve, the script prints a refresh token.

> If you're running from a local clone instead of a global install, this same command is `npm run login`.

### 4. Configure your MCP host

**opencode** — add to `opencode.json` (or `.opencode/opencode.json` in a project):

```json
{
  "mcp": {
    "zeptomail": {
      "type": "local",
      "command": ["zeptomail-mcp"],
      "enabled": true,
      "environment": {
        "ZOHO_CLIENT_ID": "...",
        "ZOHO_CLIENT_SECRET": "...",
        "ZOHO_REFRESH_TOKEN": "...",
        "ZOHO_ACCOUNTS_URL": "https://accounts.zoho.com"
      }
    }
  }
}
```

If you installed from a local clone instead, replace `["zeptomail-mcp"]` with `["node", "/absolute/path/to/zeptomail-mcp/dist/src/server.js"]`.

**Claude Desktop** — `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "zeptomail": {
      "command": "zeptomail-mcp",
      "env": {
        "ZOHO_CLIENT_ID": "...",
        "ZOHO_CLIENT_SECRET": "...",
        "ZOHO_REFRESH_TOKEN": "...",
        "ZOHO_ACCOUNTS_URL": "https://accounts.zoho.com"
      }
    }
  }
}
```

If you installed from a local clone, replace `"command": "zeptomail-mcp"` with `"command": "node"` and add `"args": ["/absolute/path/to/zeptomail-mcp/dist/src/server.js"]`.

### 5. Use it

Ask your agent to call the tools:

- "list my ZeptoMail agents"
- "find the template with alias `team_invite`"
- "show me the OTP template in the sandbox agent"

## Self Client setup

A Self Client has no redirect URI, so `zeptomail-mcp-login` cannot catch its callback. Instead:

1. API Console → Self Client → **Generate Code**.
2. Scope: `Zeptomail.MailAgents.READ,Zeptomail.MailTemplates.All` → CREATE.
3. Copy the generated code and exchange it:

```bash
curl -X POST https://accounts.zoho.com/oauth/v2/token \
  -d "code=<generated code>" \
  -d "client_id=<client id>" \
  -d "client_secret=<client secret>" \
  -d "grant_type=authorization_code" \
  -d "redirect_uri=https://api-console.zoho.com/"
```

The JSON response contains `refresh_token`.

## Tools

| MCP tool                    | Purpose                                              | Mutates data |
| --------------------------- | ---------------------------------------------------- | ------------ |
| `zeptomail_list_agents`     | List accessible Agents and exact Agent keys/aliases  | No           |
| `zeptomail_list_templates`  | List templates in one explicit Agent                 | No           |
| `zeptomail_find_templates`  | Search one Agent or all Agents by name/alias/subject | No           |
| `zeptomail_get_template`    | Read one complete template from one Agent            | No           |
| `zeptomail_create_template` | Create a template in one explicit Agent              | Yes          |
| `zeptomail_update_template` | Partial update with Agent + stale-write protection   | Yes          |
| `zeptomail_delete_template` | Permanent delete with Agent/name/timestamp checks    | Yes          |

Write tools require **both**:

1. `ZEPTOMAIL_MCP_ALLOW_WRITES=true` in the server environment.
2. `confirm=true` in the individual tool call.

Every write also requires the exact `agentKey` and `expectedAgentName` from a fresh `zeptomail_list_agents` call. Update/delete additionally require current template safety values (`expectedModifiedTime`, `expectedTemplateName`), so a stale read can never overwrite a newer edit.

## Configuration reference

| Variable                           | Required    | Default                          | Purpose                                                         |
| ---------------------------------- | ----------- | -------------------------------- | --------------------------------------------------------------- |
| `ZOHO_CLIENT_ID`                   | yes         | —                                | Zoho OAuth app client ID                                        |
| `ZOHO_CLIENT_SECRET`               | yes         | —                                | Zoho OAuth app client secret                                    |
| `ZOHO_REFRESH_TOKEN`               | yes (stdio) | —                                | Long-lived token; the server mints 1-hour access tokens from it |
| `ZOHO_ACCOUNTS_URL`                | no          | `https://accounts.zoho.com`      | Zoho data center (`.eu`, `.in`, `.au`, ...)                     |
| `ZEPTOMAIL_API_BASE_URL`           | no          | `https://api.zeptomail.com/v1.1` | ZeptoMail API base URL                                          |
| `ZEPTOMAIL_MCP_ALLOW_WRITES`       | no          | `false`                          | Set `true` to enable create/update/delete                       |
| `ZEPTOMAIL_MCP_ALLOWED_AGENT_KEYS` | no          | all agents                       | Comma-separated `mailagent_key` allowlist                       |
| `ZEPTOMAIL_MCP_TRANSPORT`          | no          | `stdio`                          | `http` enables the hosted OAuth mode (below)                    |

## Hosted (remote) mode with OAuth 2.0 + PKCE

For a shared/public MCP endpoint, run with `ZEPTOMAIL_MCP_TRANSPORT=http`. The server becomes an OAuth authorization server that proxies to Zoho as the upstream authorization server:

```
MCP client ⇄ this MCP server (OAuth AS + resource server) ⇄ Zoho (upstream AS) ⇄ ZeptoMail API
```

```bash
ZEPTOMAIL_MCP_TRANSPORT=http \
ZEPTOMAIL_MCP_SERVER_URL=https://mcp.example.com \
ZEPTOMAIL_MCP_PORT=3006 \
ZEPTOMAIL_MCP_TOKEN_STORE=/var/lib/zeptomail-mcp/tokens.json \
node dist/src/server.js
```

- Clients discover metadata at `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`, dynamically register, and consent in the browser.
- The server redirects to Zoho with the client's PKCE S256 challenge and `access_type=offline`, exchanges the code with the server's Zoho client secret, and stores a **per-client Zoho refresh token** that never leaves the server.
- Each user's tools operate on their own ZeptoMail account.

Host config (opencode):

```json
{
  "mcp": {
    "zeptomail": {
      "type": "remote",
      "url": "https://mcp.example.com/mcp",
      "oauth": {}
    }
  }
}
```

Requirements for hosted mode: HTTPS (the SDK rejects non-HTTPS issuer URLs except localhost), the Zoho callback URI registered in the API console (`https://mcp.example.com/callback`), and a persistent token store. Restarting the server invalidates issued tokens — clients re-consent once.

## Development

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Security notes

- Agent discovery is read-only; there are no tools for creating Agents, generating API keys, or accessing Send Mail Tokens.
- The MCP never sends email.
- `ZEPTOMAIL_MCP_ALLOWED_AGENT_KEYS` constrains which Agents the MCP may touch even when the OAuth account can see more.
- The refresh token is a long-lived credential: keep it server-side, treat it like a password, and revoke it in the Zoho console if it ever leaks.
