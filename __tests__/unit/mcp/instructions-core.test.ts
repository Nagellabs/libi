import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createLibiMcpServer } from "@/mcp/server";
import { renderAgentInstructions, renderInstructionsCore } from "@/mcp/workspace";
import { resolveManualSection, splitManual } from "@/mcp/manual-sections";
import {
  INSTRUCTIONS_CORE_CAP,
  INSTRUCTIONS_CORE_MIN_SLACK,
  testModeCoreBanner,
} from "@/mcp/instructions";
import { TEST_MODE_FAKE_NAMES } from "@/lib/mcp-config";

/** What the assertions below are actually about: how much of Claude Code's
 *  2,048-character `instructions` budget is still unspent. */
function slack(core: string): number {
  return INSTRUCTIONS_CORE_CAP - core.length;
}

describe("renderInstructionsCore", () => {
  it("leaves real headroom under Claude Code's cap in production", () => {
    const core = renderInstructionsCore("claude");
    expect(slack(core)).toBeGreaterThanOrEqual(INSTRUCTIONS_CORE_MIN_SLACK);
    expect(core).toContain("libi.read_manual");
  });

  /**
   * This used to assert `< 2000` against a 1,980-character render — 68
   * characters, i.e. one added sentence from silent truncation, with nothing
   * failing until the day it happened. The assertion is now the SLACK, so the
   * budget is visible before it is blown rather than after.
   */
  it("still fits with the test-mode banner too (dev-only: the floor is for production; see slackFloor below)", () => {
    process.env.LIBI_TEST_MODE = "1";
    try {
      const core = renderInstructionsCore("claude");
      expect(core).toContain("TEST MODE");
      expect(slack(core)).toBeGreaterThanOrEqual(0);
    } finally {
      delete process.env.LIBI_TEST_MODE;
    }
  });

  /**
   * `POST /api/skill-eval/configure` attaches no fakes for a scenario
   * whose frontmatter lists `mcps: []` — which is the whole of what the
   * `_meta/no-provider` scenario tests. A banner announcing fal-ai and
   * ElevenLabs there tells the agent it has tools it does not have, in the one
   * run designed to prove it notices it has none.
   */
  it("drops the banner entirely when no fakes are attached", () => {
    process.env.LIBI_TEST_MODE = "1";
    try {
      const core = renderInstructionsCore("claude", { fakesAttached: false });
      expect(core).not.toContain("TEST MODE");
      for (const name of TEST_MODE_FAKE_NAMES) expect(core).not.toContain(name);
      expect(core).toContain("libi.read_manual");
    } finally {
      delete process.env.LIBI_TEST_MODE;
    }
  });

  it("names exactly the fakes that are attached, and nothing when there are none", () => {
    expect(testModeCoreBanner([])).toBeNull();
    expect(testModeCoreBanner(["fal-ai"])).toContain("is a sandboxed fake");
    expect(testModeCoreBanner(["fal-ai", "elevenlabs"])).toContain("`fal-ai` and `elevenlabs`");
    const all = testModeCoreBanner([...TEST_MODE_FAKE_NAMES])!;
    // Three names join as `a`, `b` and `c` — no Oxford comma, because the
    // core is rendered into a 2,048-character budget.
    expect(all).toContain("`fal-ai`, `elevenlabs` and `zernio`");
    expect(all).toContain("are sandboxed fakes");
    expect(all).toContain("Never promise real AI output");
  });

  it("keeps the banner itself small enough to be worth having", () => {
    // It exists because the full TEST_MODE_BANNER (818 chars) does not fit.
    expect(testModeCoreBanner([...TEST_MODE_FAKE_NAMES])!.length).toBeLessThan(250);
  });

  /**
   * Every rendering the MCP child can serve: both dialects, in production, in
   * test mode with the fakes attached (the largest), and in test mode without.
   */
  const RENDERINGS = (["claude", "codex"] as const).flatMap((dialect) => [
    { label: `${dialect}, production`, dialect, testMode: false, fakesAttached: true },
    { label: `${dialect}, test mode + fakes`, dialect, testMode: true, fakesAttached: true },
    { label: `${dialect}, test mode, no fakes`, dialect, testMode: true, fakesAttached: false },
  ]);

  /**
   * Each dialect's rendering carries one tool-loading hint (Codex's names-first filter ~145 characters, Claude's
   * one-ToolSearch edit set ~170). Claude's test-mode rendering with all three fakes already sat at 151 of the 150
   * floor, so in that one dev-only rendering neither dialect can keep the floor without cutting words both share:
   * it must still FIT (slack >= 0), nothing more. Production, and test mode without fakes, keep the full floor for
   * both dialects.
   */
  const slackFloor = (_dialect: string, testMode: boolean, fakesAttached: boolean) =>
    testMode && fakesAttached ? 0 : INSTRUCTIONS_CORE_MIN_SLACK;

  it.each(RENDERINGS)("keeps the slack floor ($label)", ({ dialect, testMode, fakesAttached }) => {
    if (testMode) process.env.LIBI_TEST_MODE = "1";
    try {
      const core = renderInstructionsCore(dialect, { fakesAttached });
      expect(slack(core)).toBeGreaterThanOrEqual(slackFloor(dialect, testMode, fakesAttached));
    } finally {
      delete process.env.LIBI_TEST_MODE;
    }
  });

  /**
   * Codex shows the model only the first 250 characters of a server's
   * `instructions` until it searches, so the opening has to say what libi IS
   * and name its domains on its own — with the read_manual pointer right after.
   */
  it.each(["claude", "codex"] as const)(
    "opens with what libi is and its domains inside the first 250 characters (%s)",
    (dialect) => {
      const core = renderInstructionsCore(dialect);
      const head = core.slice(0, 250);
      expect(head).toMatch(/^libi is an AI video studio/);
      for (const domain of [
        "timeline",
        "overlays",
        "keyframes",
        "effects",
        "audio",
        "music",
        "captions",
        "storyboard",
        "AI generation",
        "tracking",
        "background removal",
        "templates",
        "social posting",
        "export",
      ]) {
        expect(head, domain).toContain(domain);
      }
      expect(core.indexOf("libi.read_manual")).toBeGreaterThan(0);
      expect(core.indexOf("libi.read_manual")).toBeLessThan(330);
    },
  );

  /**
   * Codex (in-app Code Mode) runs a filter over ALL_TOOLS descriptions BEFORE it reads `libi.read_manual`, and
   * libi's instructions prefix every description, so every tool matches and the output is cut off (82K-96K
   * tokens, 4 of 4 runs of the 2026-10-02 fix-wave re-run). The names-first hint lives in the manual, which
   * arrives too late: one sentence of it is in the core, for the codex dialect only.
   */
  describe("the Codex names-first hint", () => {
    const FILTER = 'ALL_TOOLS.filter(t => t.name.startsWith("mcp__libi__")).map(t => t.name)';

    it("is in Codex's core, ahead of the hard rules, and says what to avoid", () => {
      const core = renderInstructionsCore("codex");
      expect(core).toContain(FILTER);
      expect(core).toContain("Never filter on `description`");
      expect(core.indexOf(FILTER)).toBeLessThan(core.indexOf("Hard rules:"));
      expect(core.indexOf(FILTER)).toBeGreaterThan(core.indexOf("libi.read_manual"));
      // dialect markers are stripped, never shown to the agent
      expect(core).not.toContain("libi-agent");
    });

    it("is not in Claude's core, which carries its own hint in the same place", () => {
      const core = renderInstructionsCore("claude");
      expect(core).not.toMatch(/ALL_TOOLS|libi-agent|Codex: list/);
      expect(core).toMatch(/is the tool reference\.\nEditing\? ONE ToolSearch, select:mcp__libi__libi_\{[^}]+\}\n\nHard rules:/);
    });

    it("is the same advice as the manual's Codex hint, and absent from the manual's Claude rendering", () => {
      expect(renderAgentInstructions("codex")).toContain(FILTER);
      expect(renderAgentInstructions("claude")).not.toContain(FILTER);
    });

    it("also reaches a Codex core rendered in test mode", () => {
      process.env.LIBI_TEST_MODE = "1";
      try {
        expect(renderInstructionsCore("codex")).toContain(FILTER);
        expect(renderInstructionsCore("claude")).not.toContain(FILTER);
      } finally {
        delete process.env.LIBI_TEST_MODE;
      }
    });
  });

  it("tells the agent what to do when a skill is missing", () => {
    expect(renderInstructionsCore("claude")).toContain("or missing a skill?");
  });

  /**
   * Live QA, 2026-09-12: asked in libi's own chat how to get libi's skills
   * into the user's own Claude Code, the agent never called
   * `libi.read_manual` and answered from memory — "copy the folders into
   * ~/.claude/skills by hand; the copies won't update" — the opposite of what
   * libi does. The right answer existed only in the manual section, and
   * nothing in the always-loaded core sent that question there.
   */
  const OWN_AGENT_SECTION = "using-libi-from-your-own-claude-code-or-codex";

  it("sends questions about using libi from the user's own Claude Code or Codex to the manual section", () => {
    const core = renderInstructionsCore("claude");
    expect(core).toContain(`\`libi.read_manual\` section \`${OWN_AGENT_SECTION}\``);
    expect(core).toContain("tools or skills");
    expect(core).toContain("own Claude Code or Codex");
    // The first fix put this at the end of the Skills paragraph and the agent
    // still answered from memory; it is a hard rule now, and says so.
    const rules = core.slice(core.indexOf("Hard rules:"), core.indexOf("Skills:"));
    expect(rules).toContain(OWN_AGENT_SECTION);
    expect(rules).toContain("from memory");
  });

  it.each(["claude", "codex"] as const)(
    "the section the core points at exists in the rendered manual (%s)",
    (dialect) => {
      const manual = renderAgentInstructions(dialect);
      expect(splitManual(manual).sections.map((s) => s.key)).toContain(OWN_AGENT_SECTION);
      const res = resolveManualSection(manual, OWN_AGENT_SECTION);
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.text).toContain("keeps them up to date");
    },
  );
});


/**
 * Claude's own tool-loading hint (agent-speed B10). Claude Code defers MCP tools, so an editing task cost 13 solo
 * ToolSearch turns in the Dreams session (19 calls, 4.4M cache-read): one `select:` for the whole editing set,
 * named in the instructions the agent reads first, makes it one. The names are wire names (`mcp__libi__libi_<tool>`,
 * what ToolSearch takes), written with a brace list to fit the 2,048-character budget.
 */
describe("Claude's edit-set ToolSearch hint", () => {
  const BRACES = /select:(mcp__libi__libi_)\{([^}]+)\}/;
  const hint = () => BRACES.exec(renderInstructionsCore("claude"));

  it("is in Claude's core, ahead of the hard rules, and not in Codex's", () => {
    const core = renderInstructionsCore("claude");
    expect(core.indexOf("ONE ToolSearch")).toBeGreaterThan(core.indexOf("libi.read_manual"));
    expect(core.indexOf("ONE ToolSearch")).toBeLessThan(core.indexOf("Hard rules:"));
    expect(core).not.toContain("libi-agent");
    expect(renderInstructionsCore("codex")).not.toMatch(/ToolSearch|select:/);
  });

  it("names the editing set: overlays, keyframes, audio (clips, duck, measure), the retime tool, render-and-look, upload, and the batch op", () => {
    const names = hint()![2].split(",");
    expect(names.sort()).toEqual(
      [
        "add_keyframe", "add_overlay", "apply_ops", "audio_add_clip", "audio_analyze", "audio_clip", "audio_duck", "clip",
        "render_overlay_frames", "update_overlay", "upload_file",
      ],
    );
  });

  it("every name it lists is a tool the server registers, on both surfaces (a stale name costs a failed search)", async () => {
    for (const surface of ["in-app", "cli"] as const) {
      const server = createLibiMcpServer({ surface });
      const [c, s] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "c", version: "0" });
      await Promise.all([server.connect(s), client.connect(c)]);
      try {
        const registered = new Set((await client.listTools()).tools.map((t) => t.name));
        for (const n of hint()![2].split(",")) expect(registered.has(`libi.${n}`), `${surface}: libi.${n}`).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    }
  });

  it("expands to a `select:` list ToolSearch can take: the wire name of each registered tool", () => {
    const [, prefix, list] = hint()!;
    const select = `select:${list.split(",").map((n) => prefix + n).join(",")}`;
    expect(select.split(",")).toHaveLength(11);
    // libi.add_overlay is served to Claude Code as mcp__libi__libi_add_overlay (the dot becomes an underscore)
    expect(select).toContain("select:mcp__libi__libi_add_overlay,mcp__libi__libi_update_overlay,");
  });
});
