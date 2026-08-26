import type { Config } from "./config.js";
import type {
  AgentListResponse,
  ScopedTemplateSummary,
  TemplateGetResponse,
  TemplateListResponse,
  TemplateMutationResponse,
  ZeptoMailAgent,
  ZeptoMailTemplate,
} from "./types.js";
import { ZohoOAuthTokenProvider } from "./zoho-oauth.js";

type FetchLike = typeof fetch;
type RequestBody = Record<string, unknown>;

export interface TokenProvider {
  getAccessToken(): Promise<string>;
  invalidate(): void;
}

export class ZeptoMailApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly responseBody: unknown,
  ) {
    super(message);
    this.name = "ZeptoMailApiError";
  }
}

export interface CreateTemplateInput {
  templateName: string;
  templateAlias?: string;
  subject: string;
  htmlBody?: string;
  textBody?: string;
}

export interface UpdateTemplateInput {
  templateName?: string;
  templateAlias?: string;
  subject?: string;
  htmlBody?: string;
  textBody?: string;
  expectedModifiedTime: string;
}

export class ZeptoMailClient {
  constructor(
    private readonly config: Config,
    private readonly tokenProvider: TokenProvider,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private agentsUrl(): string {
    return `${this.config.apiBaseUrl}/agents`;
  }

  private assertAgentAllowed(agentKey: string): void {
    if (!this.config.allowedAgentKeys?.length) return;
    if (!this.config.allowedAgentKeys.includes(agentKey)) {
      throw new Error(
        `Agent ${JSON.stringify(agentKey)} is not allowed by ZEPTOMAIL_MCP_ALLOWED_AGENT_KEYS.`,
      );
    }
  }

  private templateCollectionUrl(agentKey: string): string {
    this.assertAgentAllowed(agentKey);
    return `${this.agentsUrl()}/${encodeURIComponent(agentKey)}/templates`;
  }

  private templateUrl(agentKey: string, templateKey: string): string {
    return `${this.templateCollectionUrl(agentKey)}/${encodeURIComponent(templateKey)}`;
  }

  private async request<T>(
    url: string,
    init: RequestInit,
    retryAuth = true,
  ): Promise<T> {
    const accessToken = await this.tokenProvider.getAccessToken();
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Zoho-oauthtoken ${accessToken}`);
    headers.set("Accept", "application/json");
    if (init.body && !headers.has("Content-Type"))
      headers.set("Content-Type", "application/json");

    const response = await this.fetchImpl(url, { ...init, headers });

    if (response.status === 401 && retryAuth) {
      this.tokenProvider.invalidate();
      return this.request<T>(url, init, false);
    }

    const text = await response.text();
    let payload: unknown = undefined;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      throw new ZeptoMailApiError(
        `ZeptoMail API request failed: ${response.status} ${response.statusText}`,
        response.status,
        payload,
      );
    }

    return payload as T;
  }

  async listAgents(): Promise<ZeptoMailAgent[]> {
    const result = await this.request<AgentListResponse>(this.agentsUrl(), {
      method: "GET",
    });
    const agents = result.data ?? [];
    if (!this.config.allowedAgentKeys?.length) return agents;
    return agents.filter((agent) =>
      this.config.allowedAgentKeys!.includes(agent.mailagent_key),
    );
  }

  async getAgent(agentKey: string): Promise<ZeptoMailAgent> {
    this.assertAgentAllowed(agentKey);
    const agents = await this.listAgents();
    const agent = agents.find(
      (candidate) => candidate.mailagent_key === agentKey,
    );
    if (!agent)
      throw new Error(
        `No accessible ZeptoMail Agent found for key ${JSON.stringify(agentKey)}.`,
      );
    return agent;
  }

  async assertExpectedAgentName(
    agentKey: string,
    expectedAgentName: string,
  ): Promise<ZeptoMailAgent> {
    const agent = await this.getAgent(agentKey);
    if (agent.mailagent_name !== expectedAgentName) {
      throw new Error(
        `Agent-name safety check failed. Expected ${JSON.stringify(expectedAgentName)}, ` +
          `found ${JSON.stringify(agent.mailagent_name)} for key ${JSON.stringify(agentKey)}.`,
      );
    }
    return agent;
  }

  async listTemplates(
    agentKey: string,
    offset = 0,
    limit = 50,
  ): Promise<TemplateListResponse> {
    const url = new URL(this.templateCollectionUrl(agentKey));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("limit", String(limit));
    return this.request<TemplateListResponse>(url.toString(), {
      method: "GET",
    });
  }

  async getTemplate(
    agentKey: string,
    templateKey: string,
  ): Promise<ZeptoMailTemplate> {
    const result = await this.request<TemplateGetResponse>(
      this.templateUrl(agentKey, templateKey),
      {
        method: "GET",
      },
    );
    if (!result.data) {
      throw new Error(
        `ZeptoMail returned no template for key ${JSON.stringify(templateKey)} in Agent ${JSON.stringify(agentKey)}.`,
      );
    }
    return result.data;
  }

  /**
   * Fetch every full template from one Agent, paginating through the list and
   * calling getTemplate on each. Returns each template's full HTML/text body
   * plus metadata, ready for the agent to write to local files as a backup.
   */
  async exportTemplates(agentKey: string): Promise<ZeptoMailTemplate[]> {
    const all: ZeptoMailTemplate[] = [];
    let offset = 0;
    const pageSize = 50;
    // Upper bound to prevent runaway loops against a misbehaving API.
    const maxTemplates = 1000;

    while (all.length < maxTemplates) {
      const page = await this.listTemplates(agentKey, offset, pageSize);
      const summaries = page.data ?? [];
      if (summaries.length === 0) break;

      for (const summary of summaries) {
        const full = await this.getTemplate(agentKey, summary.template_key);
        all.push(full);
      }

      const count = page.metadata?.count ?? summaries.length;
      if (count < pageSize) break;
      offset += summaries.length;
    }

    return all;
  }

  private async findTemplatesInAgent(
    agent: ZeptoMailAgent,
    query: string,
    maxResults: number,
  ): Promise<ScopedTemplateSummary[]> {
    const normalized = query.trim().toLowerCase();
    const matches: ScopedTemplateSummary[] = [];
    let offset = 0;
    const pageSize = 50;

    while (matches.length < maxResults) {
      const page = await this.listTemplates(
        agent.mailagent_key,
        offset,
        pageSize,
      );
      const templates = page.data ?? [];
      for (const template of templates) {
        const haystack = [
          template.template_name,
          template.template_alias,
          template.subject,
        ]
          .filter(Boolean)
          .join("\n")
          .toLowerCase();
        if (haystack.includes(normalized)) matches.push({ agent, template });
        if (matches.length >= maxResults) break;
      }

      const count = page.metadata?.count ?? templates.length;
      if (templates.length === 0 || count < pageSize) break;
      offset += templates.length;
    }

    return matches;
  }

  async findTemplates(
    query: string,
    maxResults = 20,
    agentKey?: string,
  ): Promise<ScopedTemplateSummary[]> {
    if (agentKey) {
      const agent = await this.getAgent(agentKey);
      return this.findTemplatesInAgent(agent, query, maxResults);
    }

    const agents = await this.listAgents();
    const matches: ScopedTemplateSummary[] = [];
    for (const agent of agents) {
      const remaining = maxResults - matches.length;
      if (remaining <= 0) break;
      matches.push(
        ...(await this.findTemplatesInAgent(agent, query, remaining)),
      );
    }
    return matches;
  }

  async createTemplate(
    agentKey: string,
    expectedAgentName: string,
    input: CreateTemplateInput,
  ): Promise<TemplateMutationResponse> {
    await this.assertExpectedAgentName(agentKey, expectedAgentName);
    if (!input.htmlBody && !input.textBody) {
      throw new Error("At least one of htmlBody or textBody is required.");
    }

    const body: RequestBody = {
      template_name: input.templateName,
      subject: input.subject,
    };
    if (input.templateAlias) body.template_alias = input.templateAlias;
    if (input.htmlBody) body.htmlbody = input.htmlBody;
    if (input.textBody) body.textbody = input.textBody;

    return this.request<TemplateMutationResponse>(
      this.templateCollectionUrl(agentKey),
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );
  }

  async updateTemplate(
    agentKey: string,
    templateKey: string,
    expectedAgentName: string,
    input: UpdateTemplateInput,
  ): Promise<TemplateMutationResponse> {
    await this.assertExpectedAgentName(agentKey, expectedAgentName);
    const current = await this.getTemplate(agentKey, templateKey);

    if (
      !current.modified_time ||
      input.expectedModifiedTime !== current.modified_time
    ) {
      throw new Error(
        `Template changed since it was read. Expected modified_time=${input.expectedModifiedTime}, ` +
          `current modified_time=${current.modified_time ?? "<missing>"}. Re-read before updating.`,
      );
    }

    const htmlBody = input.htmlBody ?? current.htmlbody;
    const textBody = input.textBody ?? current.textbody;
    if (!htmlBody && !textBody)
      throw new Error("Update would remove both HTML and text bodies.");

    const body: RequestBody = {
      template_name: input.templateName ?? current.template_name,
      subject: input.subject ?? current.subject ?? "",
    };

    const alias = input.templateAlias ?? current.template_alias;
    if (alias) body.template_alias = alias;
    if (htmlBody) body.htmlbody = htmlBody;
    if (textBody) body.textbody = textBody;

    return this.request<TemplateMutationResponse>(
      this.templateUrl(agentKey, templateKey),
      {
        method: "PUT",
        body: JSON.stringify(body),
      },
    );
  }

  async deleteTemplate(
    agentKey: string,
    templateKey: string,
    expectedAgentName: string,
    expectedTemplateName: string,
    expectedModifiedTime: string,
  ): Promise<TemplateMutationResponse> {
    await this.assertExpectedAgentName(agentKey, expectedAgentName);
    const current = await this.getTemplate(agentKey, templateKey);

    if (current.template_name !== expectedTemplateName) {
      throw new Error(
        `Template-name safety check failed. Expected ${JSON.stringify(expectedTemplateName)}, ` +
          `found ${JSON.stringify(current.template_name)}.`,
      );
    }

    if (
      !current.modified_time ||
      current.modified_time !== expectedModifiedTime
    ) {
      throw new Error(
        `Template changed since it was read. Expected modified_time=${expectedModifiedTime}, ` +
          `current modified_time=${current.modified_time ?? "<missing>"}. Re-read before deleting.`,
      );
    }

    return this.request<TemplateMutationResponse>(
      this.templateUrl(agentKey, templateKey),
      {
        method: "DELETE",
      },
    );
  }
}
