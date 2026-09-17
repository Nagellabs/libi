import { describe, it, expect } from "vitest";
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
  it("leaves real headroom with the test-mode banner too", () => {
    process.env.LIBI_TEST_MODE = "1";
    try {
      const core = renderInstructionsCore("claude");
      expect(core).toContain("TEST MODE");
      expect(slack(core)).toBeGreaterThanOrEqual(INSTRUCTIONS_CORE_MIN_SLACK);
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
    const both = testModeCoreBanner([...TEST_MODE_FAKE_NAMES])!;
    expect(both).toContain("`fal-ai` and `ElevenLabs`");
    expect(both).toContain("are sandboxed fakes");
    expect(both).toContain("never promise real AI output");
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

  it.each(RENDERINGS)("keeps the slack floor ($label)", ({ dialect, testMode, fakesAttached }) => {
    if (testMode) process.env.LIBI_TEST_MODE = "1";
    try {
      const core = renderInstructionsCore(dialect, { fakesAttached });
      expect(slack(core)).toBeGreaterThanOrEqual(INSTRUCTIONS_CORE_MIN_SLACK);
    } finally {
      delete process.env.LIBI_TEST_MODE;
    }
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
