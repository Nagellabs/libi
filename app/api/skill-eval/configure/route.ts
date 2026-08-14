/**
 * Test-only: configure the inner agent's wiring for one skill-eval scenario.
 *
 * Enables exactly the requested bundled skills + MCP servers, switches the
 * active agent, regenerates the workspace (re-mirrors enabled skills + configs),
 * and invalidates the MCP-config cache + standby session so the NEXT
 * POST /api/sessions builds a freshly-wired session.
 *
 * DISABLED by default; requires `LIBI_ENABLE_TEST_ROUTES=1` (same gate as
 * /api/e2e/run-tool). The skill-eval harness sets this on the spawned libi.
 */
import { NextResponse } from "next/server";
import { eq, inArray, and, ne } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skills as skillsTable, mcpServers as mcpServersTable } from "@/lib/db/schema/sqlite";
import { prepareAgentDir } from "@/mcp/workspace";
import { invalidateMcpConfig } from "@/lib/mcp-config";
import { getLibiAgentDir } from "@/lib/libi-home";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { setApprovalMode } from "@/lib/approval/settings";
import { testRoutesEnabled } from "@/lib/security/test-routes";
import { serverLogger as logger } from "@/lib/logger";

function enabled(): boolean {
  return testRoutesEnabled();
}

export async function POST(req: Request): Promise<Response> {
  if (!enabled()) {
    return NextResponse.json({ error: "skill-eval configure is disabled here" }, { status: 403 });
  }

  let body: { skills?: string[]; mcps?: string[]; agent?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const wantSkills = body.skills ?? [];
  const wantMcps = body.mcps ?? [];
  const agent = body.agent ?? "claude-code";

  const db = getDb();

  // 1. Validate every requested skill/MCP exists; fail fast otherwise.
  const allSkills = db.select().from(skillsTable).all();
  const knownSkillNames = new Set(allSkills.map((s) => s.name));
  const missingSkills = wantSkills.filter((n) => !knownSkillNames.has(n));
  if (missingSkills.length) {
    return NextResponse.json({ error: `Unknown skills: ${missingSkills.join(", ")}` }, { status: 400 });
  }
  const allMcps = db.select().from(mcpServersTable).all();
  const knownMcpNames = new Set(allMcps.map((m) => m.name));
  const missingMcps = wantMcps.filter((n) => !knownMcpNames.has(n));
  if (missingMcps.length) {
    return NextResponse.json({ error: `Unknown MCP servers: ${missingMcps.join(", ")}` }, { status: 400 });
  }

  // 2. Enable exactly the requested skills (disable all other bundled skills
  //    so wiring is deterministic). User skills are left untouched.
  db.update(skillsTable).set({ enabled: false }).where(eq(skillsTable.source, "bundled")).run();
  if (wantSkills.length) {
    db.update(skillsTable)
      .set({ enabled: true })
      .where(and(eq(skillsTable.source, "bundled"), inArray(skillsTable.name, wantSkills)))
      .run();
  }

  // 3. Enable exactly the requested external MCP servers; disable the other
  //    external rows. The core "libi" row (id "libi") is excluded — its tools
  //    are synthesized at runtime by buildLibiEntry regardless of this flag,
  //    but we leave its row untouched to avoid confusing future readers.
  db.update(mcpServersTable)
    .set({ enabled: false })
    .where(and(eq(mcpServersTable.enabled, true), ne(mcpServersTable.id, "libi")))
    .run();
  if (wantMcps.length) {
    db.update(mcpServersTable).set({ enabled: true }).where(inArray(mcpServersTable.name, wantMcps)).run();
  }

  // 4. Regenerate workspace (re-mirror enabled skills + agent configs).
  await prepareAgentDir(getLibiAgentDir());

  // 5. Invalidate MCP-config cache so the next session build rebuilds the list.
  invalidateMcpConfig({ reason: "skill-eval-configure" });

  // 5b. Auto-approve everything (incl. paid generation tools) — this is an
  //     unattended eval with no human to click the approval card. Without
  //     "auto-with-generations", a fal-ai call fires a blocking generation
  //     approval-request the harness can't answer, and the run would time out.
  //     Set BEFORE switchAgent so the standby it creates inherits the mode.
  setApprovalMode(agent, "auto-with-generations");

  // 6. Switch agent + force a fresh standby so the next createSession is wired
  //    with the new skills/MCPs (createSession claims the standby first).
  //    switchAgent recreates a standby fire-and-forget; we additionally await
  //    an explicit createStandbySession so a freshly-wired standby is
  //    guaranteed ready before this route returns. createStandbySession is
  //    idempotent (no-ops when a standby already exists).
  const sm = getSessionManager();
  try {
    await sm.switchAgent(agent);
    await sm.createStandbySession();
  } catch (err) {
    logger.warn({ err, agent, tag: "skill-eval", op: "switch_agent_failed" }, "skill-eval configure: switchAgent failed");
    return NextResponse.json({ error: `Agent ${agent} unavailable` }, { status: 400 });
  }

  logger.info(
    { tag: "skill-eval", op: "configure", skills: wantSkills, mcps: wantMcps, agent },
    "skill-eval configured",
  );
  return NextResponse.json({ success: true, skills: wantSkills, mcps: wantMcps, agent });
}
