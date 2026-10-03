/**
 * The manual's merged-tool map (mcp/merged-tool-map.ts): the lookup that turns a VERB ("split",
 * "undo") into the merged tool that now does it. It is generated from lib/agents/merged-tools.ts, and
 * these tests hold it to the tools a real server registers, to the no-argument `read_manual` index
 * (where an agent actually meets it), and to the byte budget that index lives in.
 */
import fs from "fs";
import path from "path";
import { describe, it, expect } from "vitest";
import { renderAgentInstructions } from "@/mcp/workspace";
import {
  DEFAULT_INDEX_BUDGET_BYTES,
  renderManualIndex,
  resolveManualSection,
  splitManual,
} from "@/mcp/manual-sections";
import {
  MERGED_TOOL_MAP_GLOSS,
  MERGED_TOOL_MAP_KEY,
  renderMergedToolMap,
} from "@/mcp/merged-tool-map";
import {
  FOLDED_TOOL_FORMER_NAMES,
  MERGED_TOOL_DISCRIMINATORS,
  MERGED_TOOL_FORMER_NAMES,
  MERGED_TOOL_RISK,
  type MergedToolName,
} from "@/lib/agents/merged-tools";

const DIALECTS = ["claude", "codex"] as const;
const TOOLS = Object.keys(MERGED_TOOL_DISCRIMINATORS) as MergedToolName[];

function registeredToolNames(): Set<string> {
  const names = new Set<string>();
  for (const rel of [path.join("mcp", "server.ts"), path.join("mcp", "tracking-mcp", "register-tracking-tools.ts")]) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
    for (const m of src.matchAll(/registerTool\(\s*"(libi\.[a-z0-9_]+)"/g)) names.add(m[1]);
  }
  for (const merged of TOOLS) names.add(merged);
  return names;
}

describe("renderMergedToolMap", () => {
  it("has one line per merged tool, naming every one of its actions", () => {
    const map = renderMergedToolMap();
    expect(TOOLS.length).toBeGreaterThan(20);
    for (const tool of TOOLS) {
      const line = map.split("\n").find((l) => l.startsWith(`- \`${tool}\``));
      expect(line, `${tool} has no line in the map`).toBeDefined();
      const { readOnly, changes } = MERGED_TOOL_RISK[tool];
      for (const action of [...readOnly, ...changes]) {
        expect(line, `${tool}: the line does not name action "${action}"`).toContain(action);
      }
    }
  });

  it("names the discriminator where it is not `action`", () => {
    const map = renderMergedToolMap();
    expect(map).toContain("`libi.show` (`target`)");
    expect(map).toContain("`libi.social_link` (`kind`)");
  });

  it("routes the verbs an agent searches for to the merged tool (the Codex regression: split + delete)", () => {
    const map = renderMergedToolMap();
    const clip = map.split("\n").find((l) => l.startsWith("- `libi.clip`"))!;
    expect(clip).toMatch(/split/);
    expect(clip).toMatch(/delete/);
    expect(clip).toContain("split_clip");
    const snapshot = map.split("\n").find((l) => l.startsWith("- `libi.snapshot`"))!;
    expect(snapshot).toContain("undo");
    expect(snapshot).toContain("discard_draft");
  });

  it("lists the folded `update_piece` too", () => {
    const line = renderMergedToolMap().split("\n").find((l) => l.startsWith("- `libi.update_piece`"))!;
    expect(line).toBeDefined();
    for (const old of FOLDED_TOOL_FORMER_NAMES["libi.update_piece"]) expect(line).toContain(old);
  });

  it("stays small (the budget it must fit in is the index's)", () => {
    expect(Buffer.byteLength(renderMergedToolMap(), "utf8")).toBeLessThan(4_000);
  });
});

describe("the former-names data", () => {
  it("only names actions the tool really has", () => {
    for (const tool of TOOLS) {
      const { readOnly, changes } = MERGED_TOOL_RISK[tool];
      const actions = new Set<string>([...readOnly, ...changes]);
      for (const action of Object.keys(MERGED_TOOL_FORMER_NAMES[tool])) {
        expect(actions.has(action), `${tool}: former name for unknown action "${action}"`).toBe(true);
      }
    }
  });

  it("names no tool that is still registered (a former name is a retired one) and no `libi.` prefix", () => {
    const registered = registeredToolNames();
    const all = [
      ...TOOLS.flatMap((t) => Object.values(MERGED_TOOL_FORMER_NAMES[t] as Record<string, string>)),
      ...Object.values(FOLDED_TOOL_FORMER_NAMES).flat(),
    ];
    expect(all.length).toBeGreaterThan(100);
    for (const name of all) {
      expect(name.startsWith("libi."), name).toBe(false);
      expect(registered.has(`libi.${name}`), `${name} is still a registered tool`).toBe(false);
    }
  });

  it("gives every gloss a real merged tool", () => {
    for (const tool of Object.keys(MERGED_TOOL_MAP_GLOSS)) expect(TOOLS).toContain(tool);
  });
});

describe("in the manual an agent reads", () => {
  it.each(DIALECTS)("is a section of the manual and is inlined in the no-argument index, with room to spare (%s)", (dialect) => {
    const manual = renderAgentInstructions(dialect);
    expect(splitManual(manual).sections.map((s) => s.key)).toContain(MERGED_TOOL_MAP_KEY);

    const index = renderManualIndex(manual);
    for (const tool of TOOLS) expect(index, `${dialect}: the index does not carry ${tool}`).toContain(`\`${tool}\``);
    expect(index).toContain("\n## Planning workflow — Storyboard-first for video");

    const bytes = Buffer.byteLength(index, "utf8");
    // 1 KB of headroom: the next addition to an essential fails HERE rather than silently pushing one out.
    expect(bytes, `${dialect} index is ${bytes} bytes`).toBeLessThan(DEFAULT_INDEX_BUDGET_BYTES - 1_024);
  });

  it.each(DIALECTS)("is fetchable by its key (%s)", (dialect) => {
    const res = resolveManualSection(renderAgentInstructions(dialect), MERGED_TOOL_MAP_KEY);
    expect(res.ok).toBe(true);
    if (res.ok) for (const tool of TOOLS) expect(res.text).toContain(`\`${tool}\``);
  });

  it("the Codex name-first lookup is in the Codex index's essentials only", () => {
    const codex = renderManualIndex(renderAgentInstructions("codex"));
    expect(codex).toContain('ALL_TOOLS.filter(t => t.name.startsWith("mcp__libi__"))');
    expect(codex).toMatch(/Never filter on `description`/);
    expect(codex).toContain("tools.mcp__libi__libi_<tool>(");
    expect(codex).toContain("exec tool declaration:");
    for (const text of [renderManualIndex(renderAgentInstructions("claude")), renderAgentInstructions("claude")]) {
      expect(text).not.toContain("ALL_TOOLS");
    }
  });

  it("the map itself is the same in both dialects", () => {
    const section = (d: "claude" | "codex") => {
      const res = resolveManualSection(renderAgentInstructions(d), MERGED_TOOL_MAP_KEY);
      return res.ok ? res.text : "";
    };
    expect(section("claude")).toBe(section("codex"));
    // (the last section of the manual runs to the end marker, as `providers` did before it)
    expect(section("claude").startsWith(renderMergedToolMap())).toBe(true);
  });
});
