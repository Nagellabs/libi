/**
 * Standalone fal.ai billing-API probe — validates the EXACT production cost
 * lookup path (`lib/fal/billing.ts#fetchFalCost`) outside the app.
 *
 * Use it to answer "will cost lookup work with this key?" before (or instead
 * of) clicking around the editor:
 *
 *   npm run fal:billing:probe -- --latest-from-db
 *   npm run fal:billing:probe -- --request-id 019ec83e-... --generated-at 2026-06-11T00:00:00Z
 *   FAL_KEY=... npm run fal:billing:probe -- --request-id 019ec83e-...
 *
 * Key resolution order: FAL_KEY env var, else the fal-ai MCP row in the libi
 * DB at --libi-home (default ~/.libi; pass ~/.libi/worktrees/<name> for a
 * worktree app). The key is never printed.
 *
 * Verdicts:
 *   RESOLVED  — API works; real cost printed. The app will resolve costs.
 *   PENDING   — API + key are fine; fal just hasn't published this charge yet.
 *   FORBIDDEN — the key is not ADMIN-scoped (or missing). Create an ADMIN key
 *               at fal.ai → Dashboard → Keys and update the fal-ai MCP env.
 *   ERROR     — network / unexpected HTTP problem; raw response printed.
 *
 * Exit code: 0 for RESOLVED/PENDING (the integration works), 1 otherwise.
 */

import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";
import { fetchFalCost, billingWindowStart, FAL_BILLING_URL } from "@/lib/fal/billing";

interface Args {
  requestId?: string;
  generatedAt?: string;
  libiHome: string;
  latestFromDb: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    libiHome: path.join(os.homedir(), ".libi"),
    latestFromDb: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--request-id") args.requestId = argv[++i];
    else if (a === "--generated-at") args.generatedAt = argv[++i];
    else if (a === "--libi-home") args.libiHome = argv[++i];
    else if (a === "--latest-from-db") args.latestFromDb = true;
    else {
      console.error(`Unknown arg: ${a}`);
      process.exit(1);
    }
  }
  return args;
}

function readKeyFromDb(libiHome: string): string | null {
  const dbPath = path.join(libiHome, "libi.sqlite");
  if (!fs.existsSync(dbPath)) {
    console.error(`No DB at ${dbPath}`);
    return null;
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare("SELECT env_vars FROM mcp_servers WHERE id = 'fal-ai'")
      .get() as { env_vars?: string } | undefined;
    if (!row?.env_vars) return null;
    const parsed = JSON.parse(row.env_vars) as Record<string, unknown>;
    const key = parsed["FAL_KEY"];
    return typeof key === "string" && key.trim() !== "" ? key.trim() : null;
  } finally {
    db.close();
  }
}

function latestGenerationFromDb(
  libiHome: string,
): { requestId: string; generatedAt?: string; fileName: string } | null {
  const dbPath = path.join(libiHome, "libi.sqlite");
  if (!fs.existsSync(dbPath)) return null;
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT name,
                json_extract(ai_generation, '$.providerJobId') AS request_id,
                json_extract(ai_generation, '$.completedAt') AS completed_at
           FROM files
          WHERE json_extract(ai_generation, '$.provider') = 'fal-ai'
            AND json_extract(ai_generation, '$.providerJobId') IS NOT NULL
            AND json_extract(ai_generation, '$.costEstimate.tier') IS NOT 'test-mode'
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get() as
      | { name: string; request_id: string; completed_at: string | null }
      | undefined;
    if (!row) return null;
    return {
      requestId: row.request_id,
      generatedAt: row.completed_at ?? undefined,
      fileName: row.name,
    };
  } finally {
    db.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let requestId = args.requestId;
  let generatedAt = args.generatedAt;
  if (!requestId && args.latestFromDb) {
    const latest = latestGenerationFromDb(args.libiHome);
    if (!latest) {
      console.error(
        `No fal-ai generation with a providerJobId found in ${args.libiHome}/libi.sqlite`,
      );
      process.exit(1);
    }
    requestId = latest.requestId;
    generatedAt = generatedAt ?? latest.generatedAt;
    console.log(`Using latest generation from DB: "${latest.fileName}"`);
  }
  if (!requestId) {
    console.error(
      "Pass --request-id <fal request id> (or --latest-from-db to pick one from the libi DB).",
    );
    process.exit(1);
  }

  const apiKey = process.env.FAL_KEY ?? readKeyFromDb(args.libiHome);
  if (!apiKey) {
    console.error(
      `No key: set FAL_KEY env or configure the fal-ai MCP server in the libi DB at ${args.libiHome}.`,
    );
    process.exit(1);
  }

  const start = billingWindowStart(generatedAt);
  console.log(`Request id : ${requestId}`);
  console.log(`Query start: ${start} (generatedAt: ${generatedAt ?? "unknown → 90d fallback"})`);
  console.log(`Endpoint   : ${FAL_BILLING_URL}`);
  console.log("");

  // Raw diagnostic first — the exact HTTP conversation, for when the typed
  // outcome isn't enough.
  const rawResp = await fetch(
    `${FAL_BILLING_URL}?${new URLSearchParams({ request_id: requestId, start })}`,
    { headers: { Authorization: `Key ${apiKey}` } },
  ).catch((err: Error) => err);
  if (rawResp instanceof Error) {
    console.log(`RAW: network error — ${rawResp.message}`);
  } else {
    const bodyText = await rawResp.text().catch(() => "");
    console.log(`RAW: HTTP ${rawResp.status} — ${bodyText.slice(0, 300)}`);
  }
  console.log("");

  // The production path — identical code the app runs.
  const outcome = await fetchFalCost({ requestId, apiKey, generatedAt });
  switch (outcome.kind) {
    case "resolved":
      console.log(`VERDICT: RESOLVED — real cost $${outcome.amountUsd.toFixed(6)} USD`);
      console.log("Cost lookup is fully working with this key.");
      process.exit(0);
      break;
    case "pending":
      console.log("VERDICT: PENDING — key + API work; fal hasn't published this charge yet.");
      console.log("(For a fresh generation this usually resolves within minutes to hours.)");
      process.exit(0);
      break;
    case "forbidden":
      console.log("VERDICT: FORBIDDEN — the key can't read billing data.");
      console.log(outcome.message);
      process.exit(1);
      break;
    case "error":
      console.log(`VERDICT: ERROR — ${outcome.message}`);
      process.exit(1);
      break;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
