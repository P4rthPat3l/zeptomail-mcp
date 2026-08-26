#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import * as z from "zod/v4";
import { loadConfig, type Config } from "./config.js";
import {
  ZeptoMailApiError,
  ZeptoMailClient,
  type TokenProvider,
} from "./zeptomail-client.js";
import {
  PerClientZohoTokenProvider,
  ZohoOAuthTokenProvider,
} from "./zoho-oauth.js";
import { ZohoOAuthProvider } from "./zoho-oauth-provider.js";
import { TokenStore } from "./token-store.js";

function asText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function toolError(error: unknown) {
  if (error instanceof ZeptoMailApiError) {
    return {
      content: [
        {
          type: "text" as const,
          text: asText({
            error: error.message,
            status: error.status,
            zeptomailResponse: error.responseBody,
          }),
        },
      ],
      isError: true,
    };
  }

  return {
    content: [
      {
        type: "text" as const,
        text: error instanceof Error ? error.message : String(error),
      },
    ],
    isError: true,
  };
}

function requireWritePermission(
  config: Config,
  confirmed: boolean,
  action: string,
): void {
  if (!config.allowWrites) {
    throw new Error(
      `${action} is disabled. Set ZEPTOMAIL_MCP_ALLOW_WRITES=true in the MCP server environment after verifying read-only access.`,
    );
  }
  if (!confirmed) {
    throw new Error(
      `${action} requires confirm=true after reviewing the target Agent/template and proposed change.`,
    );
  }
}

const agentKeySchema = z
  .string()
  .min(1)
  .describe(
    "Exact mailagent_key / Agent alias returned by zeptomail_list_agents. Never guess this value.",
  );

export function buildServer(
  config: Config,
  tokenProvider: TokenProvider,
): McpServer {
  const client = new ZeptoMailClient(config, tokenProvider);
  const server = new McpServer({
    name: "zeptomail-templates",
    version: "0.3.0",
  });

  server.registerTool(
    "zeptomail_list_agents",
    {
      title: "List ZeptoMail Agents",
      description:
        "List accessible Agents in the ZeptoMail account. Returns each Agent name and exact mailagent_key (Agent alias). Always use the returned key for template tools; do not guess Agent identifiers.",
      inputSchema: z.object({}),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      try {
        const result = await client.listAgents();
        return { content: [{ type: "text", text: asText(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "zeptomail_list_templates",
    {
      title: "List ZeptoMail templates",
      description:
        "List templates in one explicit ZeptoMail Agent. Use zeptomail_list_agents first and pass the exact returned mailagent_key.",
      inputSchema: z.object({
        agentKey: agentKeySchema,
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(50).default(50),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ agentKey, offset, limit }) => {
      try {
        const agent = await client.getAgent(agentKey);
        const result = await client.listTemplates(agentKey, offset, limit);
        return {
          content: [{ type: "text", text: asText({ agent, ...result }) }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "zeptomail_find_templates",
    {
      title: "Find ZeptoMail templates",
      description:
        "Search template name, alias and subject. Omit agentKey to search across every accessible Agent; provide agentKey to restrict the search to one Agent. Results always include the owning Agent.",
      inputSchema: z.object({
        query: z.string().min(1),
        agentKey: agentKeySchema.optional(),
        maxResults: z.number().int().min(1).max(50).default(20),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ query, agentKey, maxResults }) => {
      try {
        const result = await client.findTemplates(query, maxResults, agentKey);
        return { content: [{ type: "text", text: asText(result) }] };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "zeptomail_get_template",
    {
      title: "Get ZeptoMail template",
      description:
        "Fetch one complete template from one explicit Agent by exact template key. Always call this before updating or deleting.",
      inputSchema: z.object({
        agentKey: agentKeySchema,
        templateKey: z.string().min(1),
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ agentKey, templateKey }) => {
      try {
        const agent = await client.getAgent(agentKey);
        const template = await client.getTemplate(agentKey, templateKey);
        return {
          content: [{ type: "text", text: asText({ agent, template }) }],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "zeptomail_export_templates",
    {
      title: "Export all ZeptoMail templates from one Agent",
      description:
        "Fetch every full template (HTML body, text body, subject, alias, attachments metadata) from one explicit Agent and return them as a single JSON dump. Read-only. Use when the caller wants to back up an Agent templates to local files; the caller writes the files itself — this tool returns the data, it does not write to disk.",
      inputSchema: z.object({
        agentKey: agentKeySchema,
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async ({ agentKey }) => {
      try {
        const agent = await client.getAgent(agentKey);
        const templates = await client.exportTemplates(agentKey);
        return {
          content: [
            {
              type: "text",
              text: asText({ agent, count: templates.length, templates }),
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "zeptomail_create_template",
    {
      title: "Create ZeptoMail template",
      description:
        "Create a template in one explicit Agent. Requires agentKey plus expectedAgentName from a fresh zeptomail_list_agents call, server writes enabled, and confirm=true.",
      inputSchema: z
        .object({
          agentKey: agentKeySchema,
          expectedAgentName: z.string().min(1),
          templateName: z.string().min(1),
          templateAlias: z.string().min(1).optional(),
          subject: z.string().min(1),
          htmlBody: z.string().min(1).optional(),
          textBody: z.string().min(1).optional(),
          confirm: z.boolean().default(false),
        })
        .refine((value) => Boolean(value.htmlBody || value.textBody), {
          message: "At least one of htmlBody or textBody is required.",
        }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
      },
    },
    async ({ agentKey, expectedAgentName, confirm, ...input }) => {
      try {
        requireWritePermission(config, confirm, "Template creation");
        const result = await client.createTemplate(
          agentKey,
          expectedAgentName,
          {
            templateName: input.templateName,
            subject: input.subject,
            ...(input.templateAlias
              ? { templateAlias: input.templateAlias }
              : {}),
            ...(input.htmlBody ? { htmlBody: input.htmlBody } : {}),
            ...(input.textBody ? { textBody: input.textBody } : {}),
          },
        );
        return {
          content: [
            {
              type: "text",
              text: asText({ agentKey, expectedAgentName, result }),
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "zeptomail_update_template",
    {
      title: "Update ZeptoMail template",
      description:
        "Partially update a template in one explicit Agent. Requires expectedAgentName and expectedModifiedTime from fresh reads so a stale or wrong-Agent edit is rejected. Requires writes enabled and confirm=true.",
      inputSchema: z
        .object({
          agentKey: agentKeySchema,
          expectedAgentName: z.string().min(1),
          templateKey: z.string().min(1),
          templateName: z.string().min(1).optional(),
          templateAlias: z.string().min(1).optional(),
          subject: z.string().min(1).optional(),
          htmlBody: z.string().min(1).optional(),
          textBody: z.string().min(1).optional(),
          expectedModifiedTime: z.string().min(1),
          confirm: z.boolean().default(false),
        })
        .refine(
          (value) =>
            Boolean(
              value.templateName ||
              value.templateAlias ||
              value.subject ||
              value.htmlBody ||
              value.textBody,
            ),
          { message: "Provide at least one template field to update." },
        ),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({ agentKey, expectedAgentName, templateKey, confirm, ...input }) => {
      try {
        requireWritePermission(config, confirm, "Template update");
        const result = await client.updateTemplate(
          agentKey,
          templateKey,
          expectedAgentName,
          {
            expectedModifiedTime: input.expectedModifiedTime,
            ...(input.templateName ? { templateName: input.templateName } : {}),
            ...(input.templateAlias
              ? { templateAlias: input.templateAlias }
              : {}),
            ...(input.subject ? { subject: input.subject } : {}),
            ...(input.htmlBody ? { htmlBody: input.htmlBody } : {}),
            ...(input.textBody ? { textBody: input.textBody } : {}),
          },
        );
        return {
          content: [
            {
              type: "text",
              text: asText({ agentKey, expectedAgentName, result }),
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "zeptomail_delete_template",
    {
      title: "Delete ZeptoMail template",
      description:
        "Permanently delete a template from one explicit Agent. Requires expectedAgentName, expectedTemplateName, and expectedModifiedTime from fresh reads. Requires writes enabled and confirm=true.",
      inputSchema: z.object({
        agentKey: agentKeySchema,
        expectedAgentName: z.string().min(1),
        templateKey: z.string().min(1),
        expectedTemplateName: z.string().min(1),
        expectedModifiedTime: z.string().min(1),
        confirm: z.boolean().default(false),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
      },
    },
    async ({
      agentKey,
      expectedAgentName,
      templateKey,
      expectedTemplateName,
      expectedModifiedTime,
      confirm,
    }) => {
      try {
        requireWritePermission(config, confirm, "Template deletion");
        const result = await client.deleteTemplate(
          agentKey,
          templateKey,
          expectedAgentName,
          expectedTemplateName,
          expectedModifiedTime,
        );
        return {
          content: [
            {
              type: "text",
              text: asText({ agentKey, expectedAgentName, result }),
            },
          ],
        };
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

function startStdio(config: Config): void {
  const tokenProvider = new ZohoOAuthTokenProvider(config);
  const server = buildServer(config, tokenProvider);
  const transport = new StdioServerTransport();
  void server.connect(transport);
  console.error("ZeptoMail multi-Agent template MCP server listening on stdio");
}

function startHttp(config: Config): void {
  const store = new TokenStore(config.tokenStorePath);
  const oauthProvider = new ZohoOAuthProvider(config, store);
  const app = createMcpExpressApp();

  const mcpServerUrl = new URL(`${config.serverUrl}/mcp`);
  app.use(
    mcpAuthRouter({
      provider: oauthProvider,
      issuerUrl: new URL(config.serverUrl),
      resourceServerUrl: mcpServerUrl,
      scopesSupported: ["mcp:tools"],
      resourceName: "ZeptoMail Templates MCP",
    }),
  );

  const authMiddleware = requireBearerAuth({
    verifier: oauthProvider,
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpServerUrl),
  });

  app.get("/callback", (req, res) => {
    const code =
      typeof req.query.code === "string" ? req.query.code : undefined;
    const state =
      typeof req.query.state === "string" ? req.query.state : undefined;
    if (!code || !state) {
      res.status(400).send("Missing code or state parameter");
      return;
    }
    const result = oauthProvider.handleCallback(code, state);
    if ("error" in result) {
      res.status(400).send(result.error);
      return;
    }
    res.redirect(result.redirectUrl);
  });

  const transports = new Map<string, StreamableHTTPServerTransport>();

  const mcpHandler = async (
    req: Parameters<typeof authMiddleware>[0],
    res: Parameters<typeof authMiddleware>[1],
  ) => {
    const sessionIdHeader = req.headers["mcp-session-id"];
    const sessionId = Array.isArray(sessionIdHeader)
      ? sessionIdHeader[0]
      : sessionIdHeader;
    try {
      let transport: StreamableHTTPServerTransport | undefined;
      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId);
      } else if (
        !sessionId &&
        req.body &&
        typeof req.body === "object" &&
        (req.body as { method?: string }).method === "initialize"
      ) {
        const clientId = req.auth?.clientId;
        const tokenProvider = new PerClientZohoTokenProvider(config, () => {
          const entry = store.getClient(clientId ?? "");
          return entry?.zohoRefreshToken ?? "";
        });
        const server = buildServer(config, tokenProvider);
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, transport as StreamableHTTPServerTransport);
          },
        });
        transport.onclose = () => {
          if (transport?.sessionId) transports.delete(transport.sessionId);
        };
        await server.connect(
          transport as import("@modelcontextprotocol/sdk/shared/transport.js").Transport,
        );
      } else {
        res.status(400).json({
          jsonrpc: "2.0",
          error: {
            code: -32000,
            message: "Bad Request: No valid session ID provided",
          },
          id: null,
        });
        return;
      }
      if (!transport) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
        return;
      }
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  };

  app.post("/mcp", authMiddleware, mcpHandler);
  app.get("/mcp", authMiddleware, mcpHandler);
  app.delete("/mcp", authMiddleware, mcpHandler);

  app.listen(config.port, () => {
    console.error(
      `ZeptoMail MCP server listening on ${config.serverUrl} (OAuth enabled)`,
    );
  });
}

const config = loadConfig();
if (config.transport === "http") {
  startHttp(config);
} else {
  startStdio(config);
}
