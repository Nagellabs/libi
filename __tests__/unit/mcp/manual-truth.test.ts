import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import { renderAgentInstructions } from "@/mcp/workspace";
import { LIBI_SKILL_VERSION } from "@/mcp/version";
import {
  ALL_SECTIONS_KEY,
  renderManualIndex,
  resolveManualSection,
  splitManual,
} from "@/mcp/manual-sections";

/**
 * The manual (`mcp/templates/instructions.md`) is the one file on this branch
 * where a regression is invisible until a user hits it: it is inlined into
 * every session, and nothing else fails when it names a tool that no longer
 * exists — the agent just calls it, gets `tool not found`, and improvises.
 *
 * Three agents tripped over exactly that before the provider rewrite:
 * the manual still taught `libi.list_bundled_mcps`, `libi.show_api_config`,
 * `libi.upload_file_to_fal`, `libi.refine_track_with_sam2`,
 * `libi.compute_object_track_providers`, `libi.list_mcp_servers`, the
 * `mcp__YouTube_Downloader__ytdlp_*` bundled MCP, a `provider: "elevenlabs"`
 * parameter that was deleted, and three `libi.*_audio_track` tools that had
 * been renamed to `libi.audio_*_clip`. There was no test that would have
 * caught any of it. This is that test.
 *
 * The load-bearing assertion is the SECOND one: rather than pinning a list of
 * names someone has to remember to extend, it cross-checks every `libi.*` the
 * manual names against the tools actually registered, so the NEXT removal
 * fails here automatically.
 */

/** Tool names the manual must never resurrect, with why each one is gone. */
const REMOVED_TOOLS: readonly string[] = [
  // libi registers no third-party MCP and holds no provider key.
  "libi.list_bundled_mcps",
  "libi.show_api_config",
  "libi.register_mcp_server",
  // Folded into `libi.list_providers().extensions`.
  "libi.list_mcp_servers",
  // A provider's own upload tool does this; libi never handles the key.
  "libi.upload_file_to_fal",
  // Paid mask refinement removed permanently.
  "libi.refine_track_with_sam2",
  "libi.compute_object_track_providers",
  // Removed with the Script tab.
  "libi.extra_analysis_model",
  // Renamed to the audio CLIP tools.
  "libi.add_audio_track",
  "libi.update_audio_track",
  "libi.remove_audio_track",
  // Renamed to `libi.show_extension` with the Agents page.
  "libi.show_mcp_settings",
];

/** Non-tool strings that each encode a model of libi that is no longer true. */
const REMOVED_CLAIMS: readonly [string, string][] = [
  // Replaced by libi's own `libi.download_video` job runner.
  ["YouTube_Downloader", "the bundled YouTube MCP was replaced by libi.download_video"],
  // The ElevenLabs STT client is deleted; transcription is Whisper-only.
  ['provider: "elevenlabs"', "libi.analysis_transcribe_audio has no provider parameter"],
  // libi bundles no MCP and holds no key.
  ["Bundled MCP", "libi bundles no MCP servers"],
  ["bundled MCP", "libi bundles no MCP servers"],
  ["mcp_servers", "the mcp_servers table holds only libi's own extension rows"],
  // The Settings surface was renamed.
  ["MCPs & Skills", "the page is Agents"],
  ["MCP Servers tab", "the tab is libi MCP"],
  // The settings page was replaced by the Agents page (Agents / libi MCP / Providers tabs).
  ["Providers & Skills", "the page is Agents"],
  // The card rewrite: suggest_provider no longer prints a command in the app,
  // and never prints one for a provider the user already has.
  ["`libi.suggest_provider` prints it", "in the app suggest_provider returns a card, and never a command for a provider the user already has"],
  // Guards against the panel era coming back: suggest_provider puts a card in
  // the chat itself now, not a separate panel with a "shown" status.
  ['status: "shown"', "suggest_provider's in-app result is status: \"card\", not \"shown\""],
  ["beside the chat", "the card renders in the chat, there is no separate panel beside it"],
  ["connect panel", "there is no connect panel; the card renders in the chat"],
  ["opens a panel", "suggest_provider puts a card in the chat, it does not open a panel"],
  ["re-run that command to refresh its skills", "libi keeps every recorded install up to date itself; no re-run is needed"],
  ["copies its skills there", "connect installs skills through the recorded-install service; 'copies' undersells that they stay current"],
];

/** `libi.*` names registered on the real server, parsed from the two files
 *  that call `registerTool` — a static read, so this cannot be perturbed by
 *  module mocking or the DB state of a parallel test file. */
function registeredToolNames(): Set<string> {
  const files = [
    path.join("mcp", "server.ts"),
    path.join("mcp", "tracking-mcp", "register-tracking-tools.ts"),
  ];
  const names = new Set<string>();
  for (const rel of files) {
    const src = fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
    for (const m of src.matchAll(/registerTool\(\s*"(libi\.[a-z0-9_]+)"/g)) {
      names.add(m[1]);
    }
  }
  return names;
}

/**
 * Every text an agent can actually be shown: the whole manual, the no-argument
 * index, and each section on its own. `libi.read_manual` is SECTIONED, so a
 * stale line surviving in one section is a stale line a real session gets.
 */
function everyRenderedView(dialect: "claude" | "codex"): [string, string][] {
  const manual = renderAgentInstructions(dialect);
  const views: [string, string][] = [
    [`${dialect}: whole manual`, manual],
    [`${dialect}: index (no argument)`, renderManualIndex(manual)],
  ];
  const all = resolveManualSection(manual, ALL_SECTIONS_KEY);
  expect(all.ok).toBe(true);
  if (all.ok) views.push([`${dialect}: section "${ALL_SECTIONS_KEY}"`, all.text]);
  for (const section of splitManual(manual).sections) {
    const res = resolveManualSection(manual, section.key);
    expect(res.ok, `section "${section.key}" does not resolve`).toBe(true);
    if (res.ok) views.push([`${dialect}: section "${section.key}"`, res.text]);
  }
  return views;
}

const DIALECTS = ["claude", "codex"] as const;

describe("the rendered manual tells the truth about libi", () => {
  it.each(DIALECTS)("names no removed tool, in any section (%s)", (dialect) => {
    for (const [label, text] of everyRenderedView(dialect)) {
      for (const tool of REMOVED_TOOLS) {
        expect(text, `${label} still names ${tool}`).not.toContain(tool);
      }
    }
  });

  it.each(DIALECTS)("makes no claim that stopped being true (%s)", (dialect) => {
    for (const [label, text] of everyRenderedView(dialect)) {
      for (const [claim, why] of REMOVED_CLAIMS) {
        expect(text, `${label} still says "${claim}" — ${why}`).not.toContain(claim);
      }
    }
  });

  // The guard that does not need maintaining: if a tool is deleted from the
  // server and the manual keeps naming it, this fails without anyone having
  // remembered to add it to REMOVED_TOOLS.
  it.each(DIALECTS)("every `libi.*` tool it names is actually registered (%s)", (dialect) => {
    const registered = registeredToolNames();
    // Sanity: the parse found a real tool surface, not zero names.
    expect(registered.size).toBeGreaterThan(100);

    const manual = renderAgentInstructions(dialect);
    const named = new Set(manual.match(/libi\.[a-z0-9_]+/g) ?? []);
    expect(named.size).toBeGreaterThan(50);

    const missing = [...named].filter((n) => !registered.has(n)).sort();
    expect(missing, `the manual names ${missing.length} tool(s) that do not exist`).toEqual([]);
  });

  it("has a `providers` section and no `bundled-mcps-live-by-default` one", () => {
    const keys = splitManual(renderAgentInstructions("claude")).sections.map((s) => s.key);
    expect(keys).toContain("providers");
    expect(keys).not.toContain("bundled-mcps-live-by-default");
  });

  it("teaches the provider model: suggest_provider, no key handling, the six kinds", () => {
    const manual = renderAgentInstructions("claude");
    expect(manual).toContain("libi.suggest_provider");
    expect(manual).toContain("libi.list_providers");
    // The catalog's ProviderKind union, verbatim.
    for (const kind of ["image", "video", "music", "voice", "sfx", "transcription"]) {
      expect(manual, `the manual never names the provider kind "${kind}"`).toContain(
        `\`${kind}\``,
      );
    }
    expect(manual).toContain("<your key>");
    expect(manual).toContain("Agents → Libi MCP");
  });

  it("the Version Check section agrees with LIBI_SKILL_VERSION and the start marker", () => {
    const manual = renderAgentInstructions("claude");
    const marker = manual.match(/<!-- libi-instructions-start v([\d.]+) -->/);
    expect(marker, "no libi-instructions-start marker").not.toBeNull();
    expect(marker?.[1]).toBe(LIBI_SKILL_VERSION);

    const stated = manual.match(/This manual \(version \*\*([\d.]+)\*\*\)/);
    expect(stated, "the Version Check section states no version").not.toBeNull();
    expect(stated?.[1]).toBe(LIBI_SKILL_VERSION);
  });

  it.each(DIALECTS)("teaches how libi is used from the user's own Claude Code or Codex (%s)", (dialect) => {
    const manual = renderAgentInstructions(dialect);
    const keys = splitManual(manual).sections.map((s) => s.key);
    expect(keys).toContain("using-libi-from-your-own-claude-code-or-codex");
    const section = resolveManualSection(manual, "using-libi-from-your-own-claude-code-or-codex");
    expect(section.ok).toBe(true);
    const text = section.ok ? section.text : "";
    for (const fact of [
      "libi's own chats and terminal always have libi's tools and skills",
      "libi's tools",
      "libi's skills",
      "every folder",
      "specific folders",
      "Agents → Global setup",
      "pick Claude Code or Codex at the top",
      "npx @nagellabs/libi connect [folder] [--global]",
      "keeps them up to date",
      "Remove deletes only libi's files",
      "Skipped",
      "new Claude Code or Codex session",
      "restart Codex",
      "Never run these commands yourself",
    ]) {
      expect(text, `section lacks "${fact}"`).toContain(fact);
    }
    // The three skill gates tell the agent what to do when the skill is not there.
    const missing = manual.match(/If that skill is not available in this session/g) ?? [];
    expect(missing.length).toBeGreaterThanOrEqual(3);
    if (dialect === "codex") {
      expect(manual).toContain("two parts");
      expect(manual).toContain("Global setup tab");
    }
  });
});
