import fs from "fs";
import path from "path";
import { serverLogger as logger } from "@/lib/logger";
import { LIBI_SKILL_VERSION } from "@/mcp/version";
import { getInstructions, testModeCoreBanner } from "@/mcp/instructions";
import { getDb } from "@/lib/db/client";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { buildExtensionsSection } from "@/mcp/registry/instruction-builder";
import { loadEnabledSkills } from "@/mcp/skills/loader";
import { ownAgentDirWriteOptions } from "@/mcp/skills/installs";
import { writeSkillsToWorkspace } from "@/mcp/skills/writer";
import { getLibiAgentDir } from "@/lib/libi-home";
import { notifyMcpHttpReload, TEST_MODE_FAKE_NAMES } from "@/lib/mcp-config";
import { isTestMode } from "@/lib/test-mode";

/**
 * The full instruction document an agent receives: the dialect-rendered
 * template (+ memories, + TEST MODE banner) with the libi-extensions
 * section spliced in before the end marker.
 *
 * Served BY SECTION through the `libi.read_manual` MCP tool — Claude Code
 * truncates a server's `instructions` at 2,048 characters, so the manual is
 * TIERED: the short core (`renderInstructionsCore`) goes in `instructions`,
 * and this is fetched on demand. It is ~87 KB, which a client spools to disk
 * rather than reads, so `read_manual` splits it with
 * `mcp/manual-sections.ts` (index + essentials by default, one section by
 * key, `section: "all"` for the whole thing). `prepareAgentDir` no longer
 * writes this to CLAUDE.md / AGENTS.md — the in-app agent dir carries no
 * instruction files; instructions travel over MCP (the `instructions` field +
 * `read_manual`).
 */
export function renderAgentInstructions(dialect: "claude" | "codex"): string {
  // The extensions section is dialect-neutral; it is appended to whichever
  // dialect-rendered instructions the caller asked for.
  let externalSection: string | null = null;
  try {
    const db = getDb();
    const rows = db.select().from(mcpServers).all();
    externalSection = buildExtensionsSection(rows) || null;
  } catch (err) {
    logger.warn(
      { err, tag: "instructions", op: "external_section_failed" },
      "Failed to build extensions section",
    );
  }
  const instructions = getInstructions(dialect);
  if (!externalSection) return instructions;
  const endMarker = "<!-- libi-instructions-end -->";
  const endIdx = instructions.indexOf(endMarker);
  return endIdx !== -1
    ? instructions.slice(0, endIdx) + externalSection + "\n" + instructions.slice(endIdx)
    : instructions + "\n" + externalSection;
}

/**
 * Candidate locations of `mcp/instructions-core.md`, mirroring how
 * `lib/instructions/bundled-template.ts` finds `mcp/templates/instructions.md`.
 *
 * The `.md` is NOT compiled into `dist-cli/` (`scripts/build-cli.js` only
 * transpiles `.ts`/`.tsx`), but `package.json#files` ships the whole of `mcp/`,
 * so the source `.md` sits at `<packageRoot>/mcp/instructions-core.md` in every
 * artifact. From `dist-cli/mcp/workspace.js` that is `../../mcp/…`; in-tree
 * (tsx) it is `__dirname` itself.
 */
function coreCandidates(): string[] {
  return [
    path.resolve(__dirname, "instructions-core.md"),
    path.resolve(__dirname, "..", "..", "mcp", "instructions-core.md"),
    path.resolve(__dirname, "..", "mcp", "instructions-core.md"),
    path.join(process.cwd(), "mcp", "instructions-core.md"),
  ];
}

/**
 * The SHORT self-contained core an MCP client receives as `instructions`.
 * Claude Code truncates that field at 2,048 characters, so this must stay well
 * under it — including the condensed TEST MODE banner prepended here when
 * `LIBI_TEST_MODE` is set. The core's own job is to tell the agent to call
 * `libi.read_manual` for everything else, a section at a time.
 *
 * `dialect` is accepted for symmetry with `renderAgentInstructions` and is
 * currently unused: both CLIs read the same core.
 *
 * DELIBERATELY IGNORES `readInstructionsOverride()`. A user's override
 * replaces the MANUAL (it reaches the agent through `read_manual`, via
 * `getInstructions` → `renderAgentInstructions`); this core is the 2,048-char
 * budget Claude Code allows the `instructions` field, and an override of
 * arbitrary length would blow it and be silently truncated — taking the
 * "call `libi.read_manual`" pointer with it, at which point the override
 * itself never gets read either. The size cap is the reason, not an oversight.
 */
export function renderInstructionsCore(
  dialect: "claude" | "codex",
  opts: { fakesAttached?: boolean } = {},
): string {
  void dialect;
  let core: string | null = null;
  for (const filePath of coreCandidates()) {
    if (fs.existsSync(filePath)) {
      core = fs.readFileSync(filePath, "utf-8");
      break;
    }
  }
  if (core === null) {
    throw new Error(
      `instructions-core.md not found (tried: ${coreCandidates().join(", ")})`,
    );
  }
  if (!isTestMode()) return core;
  // `fakesAttached` comes from the studio process, which owns the flag
  // (`lib/mcp-config.ts#testModeFakesEnabled`) and ships it to this one in the
  // `/reload` body. Default true = the flag's own default, so a caller that
  // has not been told anything yet is not wrong.
  const banner = testModeCoreBanner(
    opts.fakesAttached === false ? [] : [...TEST_MODE_FAKE_NAMES],
  );
  return banner ? `${banner}\n\n${core}` : core;
}

/**
 * Prepare the in-app agent workspace (`<LIBI_HOME>/agent`): the version
 * marker and the mirrored skills. Instructions are NOT written here any more —
 * they travel in the MCP `instructions` field (see mcp/http/session.ts) — and
 * no MCP config file is written: the ACP entry is built in memory
 * (lib/mcp-config.ts#getMcpServersForAcp).
 */
export async function prepareAgentDir(workspaceDir: string): Promise<void> {
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, ".version"), LIBI_SKILL_VERSION);

  // Write skills (SKILL.md per dialect). Failure to write skills must not
  // prevent the rest of workspace prep from succeeding.
  try {
    const skills = await loadEnabledSkills();
    await writeSkillsToWorkspace(workspaceDir, skills, ownAgentDirWriteOptions());
  } catch (err) {
    logger.error(
      { err, tag: "skills", op: "write_failed_during_workspace_prep" },
      "skills.write_failed_during_workspace_prep",
    );
  }
}

const LEGACY_AGENT_DIR_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  ".mcp.json",
  path.join(".claude", "settings.local.json"),
];

/**
 * One-time upgrade strip: files pre-HTTP versions wrote into the agent dir.
 * The `claude-agent-acp` adapter also reads a workspace `.mcp.json`, so a
 * stale one would register libi twice alongside the HTTP aggregator entry.
 * Idempotent — returns what it actually removed, and logs only when it
 * removed something.
 */
export function stripLegacyAgentDirFiles(workspaceDir: string): string[] {
  const removed: string[] = [];
  for (const rel of LEGACY_AGENT_DIR_FILES) {
    const abs = path.join(workspaceDir, rel);
    if (fs.existsSync(abs)) {
      fs.rmSync(abs, { force: true });
      removed.push(abs);
    }
  }
  if (removed.length) {
    logger.info(
      { tag: "lifecycle", op: "legacy_agent_dir_strip", removed },
      "removed pre-HTTP agent-dir files",
    );
  }
  return removed;
}

/**
 * Regenerate the in-app agent workspace (skills + version) after a settings
 * change, notify the running HTTP MCP aggregator to reload (instructions
 * are read fresh per-session there, not from disk here),
 * then terminate every running agent session so they pick up the new
 * instructions on next activation.
 *
 * Returns the number of sessions that were running before reset.
 */
export async function regenerateAndRestart(): Promise<{ sessionsTerminated: number }> {
  // Lazy-import to avoid pulling agent-process modules into MCP/CLI bundles.
  const { getProcessManager } = await import("@/lib/agents/process-manager");
  const { getSessionManager } = await import("@/lib/sessions/session-manager");

  // 1. Re-write the agent dir (skills + version) and tell the aggregator to
  //    reload — new sessions get the new instructions/tools immediately.
  const sm = getSessionManager();
  await prepareAgentDir(getLibiAgentDir());
  notifyMcpHttpReload("regenerate");

  // 2. Terminate processes and reset session state.
  const pm = getProcessManager();
  const sessionsTerminated = await pm.terminateAll();
  sm.resetAll(sessionsTerminated);

  logger.info({ sessionsTerminated }, "workspace.regenerate");
  return { sessionsTerminated };
}
