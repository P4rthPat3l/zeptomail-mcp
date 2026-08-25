export interface Config {
  clientId: string;
  clientSecret: string;
  refreshToken: string | undefined;
  accountsUrl: string;
  apiBaseUrl: string;
  allowWrites: boolean;
  allowedAgentKeys: string[] | undefined;
  transport: 'stdio' | 'http';
  serverUrl: string;
  port: number;
  tokenStorePath: string;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function parseCsv(value: string | undefined): string[] | undefined {
  const items = value
    ?.split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items && items.length > 0 ? [...new Set(items)] : undefined;
}

export function loadConfig(): Config {
  const transport =
    process.env.ZEPTOMAIL_MCP_TRANSPORT?.trim().toLowerCase() === 'http' ? 'http' : 'stdio';
  return {
    clientId: required('ZOHO_CLIENT_ID'),
    clientSecret: required('ZOHO_CLIENT_SECRET'),
    refreshToken: process.env.ZOHO_REFRESH_TOKEN?.trim() || undefined,
    accountsUrl: trimTrailingSlash(
      process.env.ZOHO_ACCOUNTS_URL?.trim() || 'https://accounts.zoho.com',
    ),
    apiBaseUrl: trimTrailingSlash(
      process.env.ZEPTOMAIL_API_BASE_URL?.trim() || 'https://api.zeptomail.com/v1.1',
    ),
    allowWrites: process.env.ZEPTOMAIL_MCP_ALLOW_WRITES?.trim().toLowerCase() === 'true',
    allowedAgentKeys: parseCsv(process.env.ZEPTOMAIL_MCP_ALLOWED_AGENT_KEYS),
    transport,
    serverUrl: trimTrailingSlash(
      process.env.ZEPTOMAIL_MCP_SERVER_URL?.trim() || 'http://localhost:3006',
    ),
    port: Number(process.env.ZEPTOMAIL_MCP_PORT?.trim() || '3006'),
    tokenStorePath: process.env.ZEPTOMAIL_MCP_TOKEN_STORE?.trim() || 'mcp-tokens.json',
  };
}
