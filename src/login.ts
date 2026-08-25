#!/usr/bin/env node
/**
 * One-shot OAuth helper: opens the Zoho consent screen, catches the
 * localhost redirect, exchanges the code, and prints the refresh token.
 * Paste the printed value into ZOHO_REFRESH_TOKEN in your .env / host config.
 *
 * Requires a server-based Zoho app with redirect URI http://localhost:4567/callback
 * registered (see README). Reads ZOHO_CLIENT_ID, ZOHO_CLIENT_SECRET and
 * ZOHO_ACCOUNTS_URL from the environment or a .env file in the current directory.
 */
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { spawn } from "node:child_process";

const CALLBACK_PORT = 4567;
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`;
const SCOPES = "Zeptomail.MailAgents.READ Zeptomail.MailTemplates.All";

function loadEnvFile(): void {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  const child = spawn(cmd, [url], { stdio: "ignore", detached: true });
  child.unref();
}

async function main(): Promise<void> {
  loadEnvFile();
  const clientId = required("ZOHO_CLIENT_ID");
  const clientSecret = required("ZOHO_CLIENT_SECRET");
  const accountsUrl = (
    process.env.ZOHO_ACCOUNTS_URL?.trim() || "https://accounts.zoho.com"
  ).replace(/\/+$/, "");

  const authUrl = new URL(`${accountsUrl}/oauth/v2/auth`);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("scope", SCOPES);
  authUrl.searchParams.set("access_type", "offline");

  const codePromise = new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400).end(`Authorization failed: ${error}`);
        reject(new Error(`Zoho returned error: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400).end("Missing authorization code");
        reject(new Error("Missing authorization code"));
        return;
      }
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          "<h3>ZeptoMail MCP — authorized</h3><p>You can close this tab and return to your terminal.</p>",
        );
      server.close();
      resolve(code);
    });
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      console.log(
        `Waiting for the Zoho consent redirect on ${REDIRECT_URI} ...`,
      );
    });
    server.on("error", (err) => reject(err));
  });

  console.log(
    "\nOpen this URL in your browser and authorize ZeptoMail template access:\n",
  );
  console.log(`  ${authUrl.toString()}\n`);
  openBrowser(authUrl.toString());

  const code = await codePromise;

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
  });
  const response = await fetch(`${accountsUrl}/oauth/v2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json()) as {
    refresh_token?: string;
    error?: string;
  };
  if (!response.ok || !payload.refresh_token) {
    throw new Error(
      `Token exchange failed: ${payload.error ?? `HTTP ${response.status}`}`,
    );
  }

  console.log(
    "\nRefresh token (add to your .env / host config as ZOHO_REFRESH_TOKEN):\n",
  );
  console.log(`  ${payload.refresh_token}\n`);
}

main().catch((error) => {
  console.error(
    `\nlogin failed: ${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exit(1);
});
