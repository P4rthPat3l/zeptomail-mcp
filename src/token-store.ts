import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export interface StoredClientTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}

export interface StoredClient {
  client: OAuthClientInformationFull;
  /** Zoho refresh token obtained during this client's consent. Never leaves the server. */
  zohoRefreshToken: string;
  tokens: StoredClientTokens;
}

interface StoreFile {
  clients: Record<string, StoredClient>;
}

/**
 * Persists per-MCP-client OAuth state (client registration, our access/refresh
 * tokens, and the Zoho refresh token obtained during that client's consent)
 * in a single JSON file with 0600 permissions.
 */
export class TokenStore {
  private data: StoreFile = { clients: {} };

  constructor(private readonly filePath: string) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as StoreFile;
      this.data = { clients: parsed.clients ?? {} };
    } catch {
      this.data = { clients: {} };
    }
  }

  getClient(clientId: string): StoredClient | undefined {
    return this.data.clients[clientId];
  }

  setClient(clientId: string, entry: StoredClient): void {
    this.data.clients[clientId] = entry;
    this.persist();
  }

  deleteClient(clientId: string): void {
    delete this.data.clients[clientId];
    this.persist();
  }

  allClients(): StoredClient[] {
    return Object.values(this.data.clients);
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }
}
