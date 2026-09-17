/**
 * Test-only: configure the inner agent's wiring for one skill-eval scenario.
 *
 * Enables exactly the requested bundled skills, validates the requested MCPs
 * against what the harness can actually put in front of the agent, decides
 * whether the test-mode fakes ride along, switches the active agent,
 * regenerates the workspace (re-mirrors enabled skills + configs), and
 * invalidates the MCP-config cache + standby session so the NEXT
 * POST /api/sessions builds a freshly-wired session.
 *
 * DISABLED by default; requires `LIBI_ENABLE_TEST_ROUTES=1` (same gate as
 * /api/e2e/run-tool). The skill-eval harness sets this on the spawned libi.
 */
import { NextResponse } from "next/server";
import { eq, inArray, and } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { skills as skillsTable } from "@/lib/db/schema/sqlite";
import { prepareAgentDir } from "@/mcp/workspace";
import { EXTENSION_MCP_SERVERS } from "@/mcp/registry/bundled";
import { invalidateMcpConfig, setTestModeFakesEnabled } from "@/lib/mcp-config";
import { isTestMode } from "@/lib/test-mode";
import { getLibiAgentDir } from "@/lib/libi-home";
import { getSessionManager } from "@/lib/sessions/session-manager";
import { setApprovalMode } from "@/lib/approval/settings";
import { testRoutesEnabled } from "@/lib/security/test-routes";
import { serverLogger as logger } from "@/lib/logger";

function enabled(): boolean {
  return testRoutesEnabled();
}

/**
 * The two fakes `getMcpServersForAcp` injects over ACP in test mode, under the
 * REAL upstream names (lib/mcp-config.ts). A scenario's
 * `mcps: [fal-ai]` has always meant "expect the fake fal in front of the
 * agent"; this is the set of names that still mean that.
 */
const ACP_FAKES = new Set(["fal-ai", "ElevenLabs"]);

/**
 * Names scenarios used for MCPs that libi no longer manages as rows, mapped
 * to the extension that replaced them. `YouTube Downloader` was the yt-dlp
 * MCP's row name; that MCP was later replaced with the `youtube-download` extension
 * (`libi.download_video`). Kept so an older scenario file still resolves.
 */
const LEGACY_MCP_NAMES: Record<string, string> = {
  "YouTube Downloader": "youtube-download",
};

/** Resolve one `mcps:` entry to a libi extension id, or null if it is not one. */
function resolveExtensionId(name: string): string | null {
  const aliased = LEGACY_MCP_NAMES[name] ?? name;
  const def = EXTENSION_MCP_SERVERS.find((d) => d.id === aliased || d.name === aliased);
  return def ? def.id : null;
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

  // 1. Validate every requested skill exists; fail fast otherwise.
  const allSkills = db.select().from(skillsTable).all();
  const knownSkillNames = new Set(allSkills.map((s) => s.name));
  const missingSkills = wantSkills.filter((n) => !knownSkillNames.has(n));
  if (missingSkills.length) {
    return NextResponse.json({ error: `Unknown skills: ${missingSkills.join(", ")}` }, { status: 400 });
  }

  // 2. Validate the requested MCPs. The two fakes are injected over ACP
  //    whenever LIBI_TEST_MODE is set (lib/mcp-config.ts#getMcpServersForAcp)
  //    — there is no row to toggle any more. libi extensions are always
  //    listed and gate themselves on install state. So this is a VALIDATION
  //    step: fail loudly if a scenario asks for something the harness cannot
  //    put in front of the agent.
  const fakes: string[] = [];
  const extensions: string[] = [];
  const unprovidable: string[] = [];
  for (const name of wantMcps) {
    if (ACP_FAKES.has(name)) {
      fakes.push(name);
      continue;
    }
    const extId = resolveExtensionId(name);
    if (extId) extensions.push(extId);
    else unprovidable.push(name);
  }
  if (unprovidable.length) {
    return NextResponse.json(
      {
        error:
          `The harness cannot provide these MCPs: ${unprovidable.join(", ")}. ` +
          "Only the test-mode fakes (fal-ai, ElevenLabs) and libi extensions are available; " +
          "libi no longer manages third-party MCP rows.",
      },
      { status: 400 },
    );
  }
  if (!isTestMode()) {
    return NextResponse.json(
      { error: "skill-eval requires LIBI_TEST_MODE=1 — the fakes are only injected in test mode" },
      { status: 409 },
    );
  }

  // 3. Enable exactly the requested skills (disable all other bundled skills
  //    so wiring is deterministic). User skills are left untouched.
  db.update(skillsTable).set({ enabled: false }).where(eq(skillsTable.source, "bundled")).run();
  if (wantSkills.length) {
    db.update(skillsTable)
      .set({ enabled: true })
      .where(and(eq(skillsTable.source, "bundled"), inArray(skillsTable.name, wantSkills)))
      .run();
  }

  // 4. Regenerate workspace (re-mirror enabled skills + agent configs).
  await prepareAgentDir(getLibiAgentDir());

  // 5. The `mcps: []` contract, preserved. It used to be satisfied by
  //    disabling every non-libi mcp_servers row; those rows are gone, so it
  //    is satisfied by the process-level flag instead. A scenario that lists
  //    no MCP is asserting "the agent has NO provider" — exactly the condition
  //    the provider gate exists for, and the `_meta/no-provider` scenario
  //    is the only agent-level test of it. Attaching the fakes anyway would
  //    make that scenario test nothing while still reporting a result.
  //
  //    The two fakes are attached as a PAIR or not at all, which is what every
  //    existing scenario's frontmatter already assumes (`mcps: [fal-ai]` has
  //    always got ElevenLabs alongside it). What decides is whether the list
  //    names one of them at all: the flag used to be
  //    `wantMcps.length > 0`, so `mcps: [libi-tracking]` — an extension-only
  //    list naming no fake-backed provider — silently put a remote fal in
  //    front of an agent the scenario meant to have none, and that scenario's
  //    provider-gate behaviour tested nothing while still reporting a result.
  //
  //    Must run BEFORE step 7's switchAgent / createStandbySession: the flip
  //    invalidates the per-agent ACP cache, and a standby built from the stale
  //    list would carry the wrong MCP set into the run that follows. The
  //    setter no-ops when the value is unchanged, so a run of same-shaped
  //    scenarios does not re-POST /reload to the aggregator each time.
  const fakesFlipped = setTestModeFakesEnabled(fakes.length > 0);

  // 5b. Invalidate MCP-config cache so the next session build rebuilds the
  //     list — but only when 5a did not already do it. A flip invalidates on
  //     its own (and each invalidation is a cache rebuild plus a /reload
  //     round-trip to the aggregator), so calling it again here made every
  //     configure that changed the flag pay for two.
  if (!fakesFlipped) invalidateMcpConfig({ reason: "skill-eval-configure" });

  // 5c. Auto-approve everything — this is an unattended eval with no human to
  //     click the approval card. Without "auto-with-generations", a call into
  //     an approval-required libi extension fires a blocking approval-request
  //     the harness can't answer, and the run would time out. (The fakes never
  //     prompt.) Set BEFORE switchAgent so the standby it creates inherits it.
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
    { tag: "skill-eval", op: "configure", skills: wantSkills, mcps: wantMcps, fakes, extensions, agent },
    "skill-eval configured",
  );
  return NextResponse.json({ success: true, skills: wantSkills, mcps: wantMcps, fakes, extensions, agent });
}
