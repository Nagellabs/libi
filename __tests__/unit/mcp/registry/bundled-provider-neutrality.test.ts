/**
 * Bundled defs must not sell a third-party provider as a libi capability.
 *
 * A def's `description` and `agentInstructions` are agent-facing: they are
 * compiled into the extension list the agent reads. Three of them still said
 * "ElevenLabs remains available for …" / "Use ElevenLabs only when …", written
 * when libi bundled the ElevenLabs MCP. The ElevenLabs STT client was deleted
 * and libi now holds no ElevenLabs anything — so the agent was being told
 * a capability exists that libi cannot provide, and would reach for it.
 *
 * libi bundles NO third-party MCP any more. Every remote provider is something
 * the USER connects, which makes the rule mechanical: a bundled def may not
 * name one. What it may do is point at the provider tools — `libi.list_providers`
 * for what is connected, `libi.suggest_provider({ kind })` for how to connect
 * one.
 */
import { describe, it, expect } from "vitest";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";
import { PROVIDER_CATALOG } from "@/lib/providers/catalog";

/** Every spelling of a REMOTE provider, straight from the catalog so a new
 *  provider is covered without touching this test. On-device providers
 *  (`kind: "extension"`) are libi's own and are exempt by construction. */
const REMOTE_PROVIDER_WORDS: string[] = [
  ...new Set(
    PROVIDER_CATALOG.filter((p) => p.kind === "remote-mcp").flatMap((p) =>
      [p.id, p.name, ...p.match.names].map((w) => w.toLowerCase()),
    ),
  ),
];

/** Word-ish match so `fal` does not fire on "default"/"fallback", and the
 *  dotted/hyphenated spellings (`fal.ai`, `fal-ai`) are matched whole. */
function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`, "i").test(text);
}

describe("bundled defs are provider-agnostic", () => {
  const agentFacing = BUNDLED_MCP_SERVERS.flatMap((def) =>
    [
      { id: def.id, field: "description", text: def.description },
      { id: def.id, field: "agentInstructions", text: def.agentInstructions ?? "" },
    ].filter((s) => s.text.length > 0),
  );

  it("has strings to check (a silent empty scan would pass forever)", () => {
    expect(agentFacing.length).toBeGreaterThan(5);
    expect(REMOTE_PROVIDER_WORDS.length).toBeGreaterThan(0);
  });

  it("names no remote provider — those are the user's, not libi's", () => {
    const offenders = agentFacing.flatMap(({ id, field, text }) =>
      REMOTE_PROVIDER_WORDS.filter((w) => mentions(text, w)).map(
        (w) => `${id}.${field} mentions "${w}"`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it("routes the capabilities libi lacks through the provider tools instead", () => {
    // The three defs named above. Each says what libi cannot do and points at
    // the tool that answers "what has the user actually connected?".
    for (const id of ["whisper", "local-tts"]) {
      const def = BUNDLED_MCP_SERVERS.find((d) => d.id === id);
      expect(def, id).toBeDefined();
      const text = `${def!.description}\n${def!.agentInstructions ?? ""}`;
      expect(text, id).toContain("libi.list_providers");
      expect(text, id).toContain("libi.suggest_provider");
    }
  });
});
