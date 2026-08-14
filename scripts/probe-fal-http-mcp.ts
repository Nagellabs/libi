#!/usr/bin/env tsx
/**
 * Empirical probe of fal.ai's HTTP MCP from libi.
 *
 * Connects via the MCP SDK's StreamableHTTPClientTransport directly to
 * `https://mcp.fal.ai/mcp` using a FAL_KEY read from (in order):
 *   1. `--key <key>` CLI argument
 *   2. `FAL_KEY` env var
 *   3. The `mcp_servers` row with id='fal-ai' in `~/.libi/libi.sqlite`
 *      (envVars or headers JSON)
 *
 * Then runs `tools/list` and prints the count + first few tool names.
 *
 * This is intentionally OUTSIDE the test suite. It's a runnable probe.
 * Purpose: verify whether the fal.ai HTTP MCP is reachable with our auth,
 * so we can decide whether the `fal-ai-proxy` bundled stdio wrapper is
 * actually needed. Keep this script around as a regression probe for
 * future "is the fal.ai endpoint up?" questions.
 *
 * Usage:
 *   FAL_KEY=… npx tsx scripts/probe-fal-http-mcp.ts
 *   npx tsx scripts/probe-fal-http-mcp.ts --key …
 *   npx tsx scripts/probe-fal-http-mcp.ts          # reads key from libi DB
 *
 * Exit codes:
 *   0 — connected, tools listed
 *   1 — connection failed (network / auth / server error)
 *   2 — no FAL_KEY found
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as path from "node:path";
import * as os from "node:os";
import Database from "better-sqlite3";

const FAL_MCP_URL = "https://mcp.fal.ai/mcp";

function readKeyFromCli(): string | undefined {
  const i = process.argv.indexOf("--key");
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

function readKeyFromLibiDb(): { key: string; source: string } | null {
  const dbPath =
    process.env.LIBI_HOME != null
      ? path.join(process.env.LIBI_HOME, "libi.sqlite")
      : path.join(os.homedir(), ".libi", "libi.sqlite");
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare(
        "SELECT env_vars, headers FROM mcp_servers WHERE id = ? LIMIT 1",
      )
      .get("fal-ai") as { env_vars: string | null; headers: string | null } | undefined;
    db.close();
    if (!row) return null;
    if (row.env_vars) {
      try {
        const envObj = JSON.parse(row.env_vars) as Record<string, string>;
        if (envObj.FAL_KEY) return { key: envObj.FAL_KEY, source: "libi DB env_vars" };
      } catch {}
    }
    if (row.headers) {
      try {
        const headerObj = JSON.parse(row.headers) as Record<string, string>;
        const auth = headerObj["Authorization"];
        if (auth) {
          // Strip "Key " or "Bearer " prefix to recover the raw key
          const m = auth.match(/^(?:Key|Bearer)\s+(.+)$/i);
          if (m) return { key: m[1], source: "libi DB headers (stripped prefix)" };
        }
      } catch {}
    }
    return null;
  } catch (err) {
    console.error(
      `Could not read libi DB at ${dbPath}: ${(err as Error).message}`,
    );
    return null;
  }
}

async function probe(falKey: string, authForm: "Key" | "Bearer"): Promise<{
  ok: true;
  serverInfo: unknown;
  tools: Array<{ name: string; description?: string }>;
} | { ok: false; error: string }> {
  const url = new URL(FAL_MCP_URL);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: {
      headers: {
        Authorization: `${authForm} ${falKey}`,
      },
    },
  });
  const client = new Client(
    { name: "libi-fal-probe", version: "0.1.0" },
    { capabilities: {} },
  );
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const info = client.getServerVersion?.() ?? client.getServerCapabilities?.() ?? null;
    await client.close();
    return { ok: true, serverInfo: info, tools };
  } catch (err) {
    try {
      await client.close();
    } catch {}
    return { ok: false, error: (err as Error).message };
  }
}

async function main() {
  console.log("== fal.ai HTTP MCP probe ==");
  console.log(`Endpoint: ${FAL_MCP_URL}`);

  const cliKey = readKeyFromCli();
  const envKey = process.env.FAL_KEY;
  const dbKey = !cliKey && !envKey ? readKeyFromLibiDb() : null;

  const falKey = cliKey ?? envKey ?? dbKey?.key;
  const source = cliKey
    ? "--key CLI arg"
    : envKey
      ? "FAL_KEY env"
      : dbKey
        ? dbKey.source
        : null;

  if (!falKey) {
    console.error(
      "\nNo FAL_KEY found. Pass via --key, set FAL_KEY env, or save it in libi settings.",
    );
    process.exit(2);
  }

  console.log(`Key source: ${source}`);
  console.log(`Key prefix: ${falKey.slice(0, 8)}… (length: ${falKey.length})`);

  // Try "Key" first (what every existing libi caller uses), fall back to "Bearer"
  // (what the registry row originally had).
  for (const authForm of ["Key", "Bearer"] as const) {
    console.log(`\n→ Trying Authorization: ${authForm} <FAL_KEY>`);
    const r = await probe(falKey, authForm);
    if (r.ok) {
      console.log(`✅ CONNECTED with "${authForm}" auth form`);
      console.log(`Server: ${JSON.stringify(r.serverInfo)}`);
      console.log(`Tools (${r.tools.length}):`);
      for (const t of r.tools.slice(0, 20)) {
        console.log(`  • ${t.name}${t.description ? ` — ${t.description.slice(0, 80)}` : ""}`);
      }
      if (r.tools.length > 20) {
        console.log(`  … and ${r.tools.length - 20} more`);
      }
      process.exit(0);
    } else {
      console.log(`❌ ${r.error}`);
    }
  }

  console.error("\nBoth auth forms failed. Check the FAL_KEY value at https://fal.ai/dashboard/keys");
  process.exit(1);
}

main().catch((err) => {
  console.error("Probe crashed:", err);
  process.exit(1);
});
