#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";

// Load an env file passed as --env-file=<path>. Lets the MCP host config stay
// secret-free: "command": ["zeptomail-mcp", "--env-file=.env"]. Must run before
// importing server.js, which reads process.env at module load — so use a
// dynamic import after the env is populated.
const arg = process.argv.find((a) => a.startsWith("--env-file="));
const envPath = arg?.slice("--env-file=".length);
if (envPath && existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
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

await import("./server.js");
