import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { metricsFromClaudeLogs, normalizeToolName, median } from "@/scripts/skill-eval/bench-metrics";
import { parseScenario } from "@/scripts/skill-eval/scenario";
import { resolveSeedPlaceholders, claudeProjectDirsFor } from "@/scripts/skill-eval/harness";
import { checkPiece, musicLevelAt, T } from "@/skill-eval/scenarios/_bench/dreams-six-pieces.hooks";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const line = (o: unknown) => JSON.stringify(o);
const usage = (cr: number, out: number) => ({ input_tokens: 2, cache_read_input_tokens: cr, cache_creation_input_tokens: 100, output_tokens: out });

/** Claude Code writes one line per content block, repeating the message's usage on each. */
const LOG = [
  line({ type: "user", timestamp: "2026-10-03T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "do it" }] } }),
  line({ type: "assistant", timestamp: "2026-10-03T00:00:02.000Z", message: { id: "m1", model: "claude-opus-5-5", usage: usage(1000, 10), content: [{ type: "thinking", thinking: "" }] } }),
  line({ type: "assistant", timestamp: "2026-10-03T00:00:02.100Z", message: { id: "m1", model: "claude-opus-5-5", usage: usage(1000, 40), content: [{ type: "tool_use", id: "tu1", name: "ToolSearch", input: {} }] } }),
  line({ type: "assistant", timestamp: "2026-10-03T00:00:02.200Z", message: { id: "m1", model: "claude-opus-5-5", usage: usage(1000, 40), content: [{ type: "tool_use", id: "tu2", name: "mcp__libi__libi_audio_clip", input: {} }] } }),
  line({ type: "user", timestamp: "2026-10-03T00:00:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1" }] } }),
  line({ type: "user", isMeta: true, timestamp: "2026-10-03T00:00:03.100Z", message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: …" }] } }),
  line({ type: "assistant", timestamp: "2026-10-03T00:00:05.000Z", message: { id: "m2", model: "claude-opus-5-5", usage: usage(2000, 5), content: [{ type: "tool_use", id: "tu3", name: "Bash", input: {} }] } }),
  line({ type: "assistant", timestamp: "2026-10-03T00:00:05.000Z", message: { id: "synthetic", model: "<synthetic>", usage: usage(0, 0), content: [{ type: "text", text: "error" }] } }),
  line({ type: "user", timestamp: "2026-10-03T00:01:00.000Z", message: { role: "user", content: "next" } }),
  line({ type: "assistant", timestamp: "2026-10-03T00:01:04.000Z", message: { id: "m3", model: "claude-opus-5-5", usage: usage(3000, 7), content: [{ type: "text", text: "done" }] } }),
].join("\n");

describe("bench-metrics", () => {
  it("dedupes usage by message id and tool calls by tool_use id", () => {
    const m = metricsFromClaudeLogs([LOG]);
    expect(m.apiTurns).toBe(3);
    expect(m.cacheRead).toBe(6000); // not 1000×3 + 2000 + 3000
    expect(m.output).toBe(40 + 5 + 7); // the largest count per message
    expect(m.cacheWrite).toBe(300);
    expect(m.input).toBe(6);
    expect(m.toolCalls).toBe(3);
    expect(m.toolsByName).toEqual({ ToolSearch: 1, "libi.audio_clip": 1, Bash: 1 });
    expect(m.models).toEqual({ "claude-opus-5-5": 3 });
  });

  it("splits turns at prompts (not tool results or injected skill text), or by the harness's windows", () => {
    const byPrompt = metricsFromClaudeLogs([LOG]);
    expect(byPrompt.perTurn.map((t) => [t.apiTurns, t.toolCalls])).toEqual([[2, 3], [1, 0]]);
    expect(byPrompt.wallSec).toBe(64);
    const byWindow = metricsFromClaudeLogs([LOG], [
      { startedAt: "2026-10-03T00:00:00.000Z", endedAt: "2026-10-03T00:00:10.000Z" },
      { startedAt: "2026-10-03T00:01:00.000Z", endedAt: "2026-10-03T00:01:30.000Z" },
    ]);
    expect(byWindow.perTurn.map((t) => t.wallSec)).toEqual([10, 30]);
    expect(byWindow.wallSec).toBe(90);
  });

  it("names tools the way the analysis does", () => {
    expect(normalizeToolName("mcp__libi__libi_update_overlay")).toBe("libi.update_overlay");
    expect(normalizeToolName("mcp__libi-app__libi_show")).toBe("libi.show");
    expect(normalizeToolName("mcp__plugin_playwright_playwright__browser_click")).toBe("plugin_playwright_playwright:browser_click");
    expect(normalizeToolName("Read")).toBe("Read");
  });

  it("takes medians of what is there", () => {
    expect(median([3, null, 1, 2])).toBe(2);
    expect(median([1, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("skill-eval hooks plumbing", () => {
  it("parses the benchmark scenario, hooks included", () => {
    const path = resolve("skill-eval/scenarios/_bench/dreams-six-pieces.md");
    const s = parseScenario(readFileSync(path, "utf8"), path);
    expect(s.hooks).toBe("skill-eval/scenarios/_bench/dreams-six-pieces.hooks.ts");
    expect(s.replies).toHaveLength(2);
    expect(s.skills).toEqual(["*"]);
    expect(s.prompt).toContain("{{seed:folder}}");
  });

  it("refuses a hooks path outside the repo", () => {
    const md = (h: string) => `---\nid: x\nhooks: ${h}\n---\n## Prompt\nhi\n`;
    expect(() => parseScenario(md("/etc/hooks.ts"), "x.md")).toThrow(/repo-relative/);
    expect(() => parseScenario(md("../hooks.ts"), "x.md")).toThrow(/escape/);
  });

  it("resolves seed placeholders and fails loudly on an unknown key", () => {
    expect(resolveSeedPlaceholders('the "{{seed:folder}}" folder', { folder: "F" })).toBe('the "F" folder');
    expect(() => resolveSeedPlaceholders("{{seed:nope}}", { folder: "F" })).toThrow(/folder/);
  });

  it("finds the run's Claude project dir by the temp home's name", () => {
    const cfg = mkdtempSync(join(tmpdir(), "bench-cfg-"));
    mkdirSync(join(cfg, "projects", "-private-var-folders-x-T-libi-skilleval-AbC12z-agent"), { recursive: true });
    mkdirSync(join(cfg, "projects", "-private-var-folders-x-T-libi-skilleval-Other-agent"), { recursive: true });
    const dirs = claudeProjectDirsFor("/var/folders/x/T/libi-skilleval-AbC12z", cfg);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).toMatch(/AbC12z-agent$/);
  });
});

describe("dreams benchmark outcome checks", () => {
  const ids = { videoOverlayId: "vid", captionOverlayId: "cap", endCardOverlayId: "end", narrationClipId: "narr" };
  const piece = { name: "P", narrationFileId: "fN" };
  const shift = T.extendBy;
  const base = (music: object[]) => ({
    overlays: [
      { id: "vid", kind: "video", startTime: 0, duration: 8, trim: { start: 0, end: 8 } },
      { id: "cap", kind: "text", startTime: T.captionStart + shift, duration: T.captionDur },
      { id: "end", kind: "code", startTime: T.endStart + shift, duration: T.endDur },
    ],
    audioClips: [
      { id: "inl", kind: "inline", fileId: "fV", startTime: 0, duration: 8, volume: 1, enabled: true, linkedOverlayId: "vid" },
      { id: "narr", kind: "standalone", fileId: "fN", startTime: T.narrStart + shift, duration: T.narrDur, volume: 1, enabled: true },
      ...music,
    ],
  });

  it("passes a ducked song from the intro's end to the end", () => {
    const m = base([{ id: "mus", kind: "standalone", fileId: "fM", startTime: 8, duration: 15.5, volume: 1, enabled: true, duck: { sidechainClipIds: ["narr"], reductionDb: -12 } }]);
    const checks = checkPiece(m as never, ids, piece);
    expect(checks.filter((c) => !c.pass)).toEqual([]);
  });

  it("passes a split bed: low under the narration, full over the end card", () => {
    const m = base([
      { id: "a", kind: "standalone", fileId: "fM", startTime: 8, duration: 11.5, volume: 0.3, enabled: true },
      { id: "b", kind: "standalone", fileId: "fM", startTime: 19.5, duration: 4, volume: 1, enabled: true },
    ]);
    expect(checkPiece(m as never, ids, piece).filter((c) => !c.pass)).toEqual([]);
  });

  it("fails the untouched seed and a song that stops at the narration's end", () => {
    const untouched = {
      overlays: [
        { id: "vid", kind: "video", startTime: 0, duration: 5, trim: { start: 0, end: 5 } },
        { id: "cap", kind: "text", startTime: T.captionStart, duration: T.captionDur },
        { id: "end", kind: "code", startTime: T.endStart, duration: T.endDur },
      ],
      audioClips: [{ id: "narr", kind: "standalone", fileId: "fN", startTime: T.narrStart, duration: T.narrDur, volume: 1, enabled: true }],
    };
    expect(checkPiece(untouched as never, ids, piece).every((c) => !c.pass)).toBe(true);

    const short = base([{ id: "mus", kind: "standalone", fileId: "fM", startTime: 8, duration: 11.3, volume: 1, enabled: true, duck: { sidechainClipIds: ["narr"], reductionDb: -12 } }]);
    const failed = checkPiece(short as never, ids, piece).filter((c) => !c.pass).map((c) => c.name);
    expect(failed).toContain("P: song plays from the intro's end to the piece's end");
    expect(failed).toContain("P: song over the end card is at full level");
  });

  it("models the duck as the full reduction while a sidechain clip plays", () => {
    const narr = { id: "n", kind: "standalone" as const, fileId: "f", startTime: 10, duration: 5, volume: 1, enabled: true };
    const mus = { id: "m", kind: "standalone" as const, fileId: "g", startTime: 0, duration: 30, volume: 0.8, enabled: true, duck: { sidechainClipIds: ["n"], reductionDb: -20 } };
    expect(musicLevelAt(5, [mus], [narr, mus])).toBeCloseTo(0.8);
    expect(musicLevelAt(12, [mus], [narr, mus])).toBeCloseTo(0.08);
  });
});
