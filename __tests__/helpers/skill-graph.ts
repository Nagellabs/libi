/**
 * The bundled skill GRAPH, loaded whole, for tests that check what skills STATE instead of how
 * they word it.
 *
 * A skill is `SKILL.md` plus everything under its folder (`references/`, `prompts/`, …). A test
 * asks "is constraint X stated somewhere in skill S's graph?" — it never pins a phrase's exact
 * form or the file it lives in, so a rewrite that rewords a rule or moves it into a reference
 * keeps passing while a rewrite that DROPS the rule fails.
 *
 * Skills are being merged (see SKILL_SUCCESSORS). A test names the skill that owns a rule today;
 * once that folder is gone the helper resolves the name to whichever skill absorbed it. This is
 * the ONE place that has to learn about a merge.
 */
import fs from "node:fs";
import path from "node:path";
import { parseSkillBody } from "@/mcp/skills/frontmatter";
import type { SkillFrontmatter } from "@/mcp/skills/types";
import { RETIRED_SKILLS } from "@/mcp/skills/retired";
import { MERGED_TOOL_DISCRIMINATORS } from "@/lib/agents/merged-tools";

export const REPO_ROOT = path.resolve(__dirname, "../..");
/**
 * The `mcp/` tree every reader below looks at. `LIBI_TEST_MCP_DIR` points them at a COPY of it, which is how
 * a maintainer proves an invariant bites: copy `mcp/` elsewhere, delete the sentence that states the rule,
 * run the invariant test with the variable set, and watch it fail naming the rule. Never set it in CI.
 */
export const MCP_DIR = process.env.LIBI_TEST_MCP_DIR
  ? path.resolve(process.env.LIBI_TEST_MCP_DIR)
  : path.join(REPO_ROOT, "mcp");
export const SKILLS_DIR = path.join(MCP_DIR, "skills");

/**
 * Skill folders that were merged into another skill, old name -> where its content went. Derived from
 * `RETIRED_SKILLS` (mcp/skills/retired.ts), the one table; add a row there when a merge lands and every
 * invariant test follows it. A skill folded
 * into tool descriptions and the manual (using-piece-duplication, using-snapshot-draft,
 * using-asset-folders) has no successor skill: it maps to [] and a graph lookup for it is empty.
 */
export const SKILL_SUCCESSORS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.entries(RETIRED_SKILLS).map(([name, { successor }]) => [name, successor ? [successor] : []]),
);

export interface SkillFile {
  /** Path relative to the skill folder, forward slashes. */
  rel: string;
  text: string;
}

export interface SkillNode {
  id: string;
  dir: string;
  /** The raw SKILL.md. */
  skillMd: string;
  frontmatter: SkillFrontmatter;
  /** SKILL.md without frontmatter. */
  body: string;
  /** Every markdown file in the folder, SKILL.md included. */
  files: SkillFile[];
  /** All of `files`, joined. */
  text: string;
}

function walkMd(dir: string, base: string = dir): SkillFile[] {
  const out: SkillFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkMd(abs, base));
    else if (entry.name.endsWith(".md")) {
      out.push({
        rel: path.relative(base, abs).split(path.sep).join("/"),
        text: fs.readFileSync(abs, "utf8"),
      });
    }
  }
  // SKILL.md first, so a joined text reads the way an agent meets it and an ordering check sees the skill before its references.
  const rank = (f: SkillFile) => (f.rel === "SKILL.md" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.rel.localeCompare(b.rel));
}

let memo: Map<string, SkillNode> | null = null;

/** Every skill folder that has a SKILL.md, keyed by folder name. Read once per test file. */
export function loadSkillGraph(): Map<string, SkillNode> {
  if (memo) return memo;
  const graph = new Map<string, SkillNode>();
  for (const entry of fs.readdirSync(SKILLS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(SKILLS_DIR, entry.name);
    const skillFile = path.join(dir, "SKILL.md");
    if (!fs.existsSync(skillFile)) continue;
    const skillMd = fs.readFileSync(skillFile, "utf8");
    const { frontmatter, body } = parseSkillBody(skillMd);
    const files = walkMd(dir);
    graph.set(entry.name, {
      id: entry.name,
      dir,
      skillMd,
      frontmatter,
      body,
      files,
      text: files.map((f) => f.text).join("\n\n"),
    });
  }
  memo = graph;
  return graph;
}

export function skillIds(): string[] {
  return [...loadSkillGraph().keys()].sort();
}

/** Every name a skill has ever had that a prose mention could still use: live folders + merged-away ones. */
export function knownSkillNames(): string[] {
  return [...new Set([...skillIds(), ...Object.keys(SKILL_SUCCESSORS)])].sort();
}

/**
 * The live skill folder(s) that hold `id`'s content: `id` itself when it exists, otherwise
 * whatever absorbed it (followed transitively). Empty when nothing does.
 */
export function resolveSkill(id: string): string[] {
  const graph = loadSkillGraph();
  if (graph.has(id)) return [id];
  const out = new Set<string>();
  for (const next of SKILL_SUCCESSORS[id] ?? []) {
    for (const r of resolveSkill(next)) out.add(r);
  }
  return [...out];
}

/** The skill folders behind a list of (possibly merged-away) names. */
export function resolveSkills(ids: readonly string[]): SkillNode[] {
  const graph = loadSkillGraph();
  const seen = new Set<string>();
  const out: SkillNode[] = [];
  for (const id of ids) {
    for (const r of resolveSkill(id)) {
      if (seen.has(r)) continue;
      seen.add(r);
      out.push(graph.get(r)!);
    }
  }
  return out;
}

/** Hard-wrapped markdown splits a phrase across lines; matching runs on text with whitespace collapsed. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** Every markdown file in the named skills' folders, joined, whitespace collapsed — what an invariant is matched against. */
export function graphText(ids: readonly string[]): string {
  return collapse(
    resolveSkills(ids)
      .map((s) => s.text)
      .join("\n\n"),
  );
}

/** The SKILL.md bodies only (no references) of the named skills, joined, whitespace collapsed. */
export function bodyText(ids: readonly string[]): string {
  return collapse(
    resolveSkills(ids)
      .map((s) => s.body)
      .join("\n\n"),
  );
}

/** Does `text` name skill `id`, or the skill it was merged into? Matches a backticked or bare skill name. */
export function mentionsSkill(text: string, id: string): boolean {
  const names = [id, ...resolveSkill(id)];
  return names.some((n) => new RegExp(`(?<![a-z0-9-])${n}(?![a-z0-9-])`).test(text));
}

/** mcp/instructions-core.md — the always-loaded core of the agent instructions. Read-only here. */
export function coreText(): string {
  const p = path.join(MCP_DIR, "instructions-core.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

/** The manual source (everything `libi.read_manual` serves). Read-only here. */
export function manualText(): string {
  const p = path.join(MCP_DIR, "templates", "instructions.md");
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "";
}

function walkTs(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // The fake provider servers register their own `libi.`-free tools; skip dev fakes.
      if (entry.name === "dev" || entry.name === "node_modules") continue;
      walkTs(abs, out);
    } else if (entry.name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/**
 * Every `libi.*` tool registered on the real server, read statically from the `registerTool("libi.x"`
 * calls under mcp/ — the same approach the manual drift test takes, widened to the whole directory so
 * a tool registered from a new file is still seen — plus the merged tools (lib/agents/merged-tools.ts).
 */
export function registeredLibiTools(): Set<string> {
  const names = new Set<string>();
  for (const file of walkTs(MCP_DIR)) {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/registerTool\(\s*"(libi\.[a-z0-9_]+)"/g)) names.add(m[1]);
  }
  // Merged tools register through `registerActionTool` (a `name:` in mcp/tools/families/*), not a
  // literal `registerTool("libi.x"`; their names live in one table that a drift test holds to the server.
  for (const merged of Object.keys(MERGED_TOOL_DISCRIMINATORS)) names.add(merged);
  return names;
}

/** `libi.<tool>` tokens named in `text` (not `metadata.libi.x`, not a `libi.audio_*` wildcard). */
export function libiToolMentions(text: string): string[] {
  return [...text.matchAll(/(?<![\w.])libi\.([a-z][a-z0-9_]*)(?![\w*])/g)].map((m) => `libi.${m[1]}`);
}

/** Strip the YAML frontmatter block, if any. */
export function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n?/, "");
}
