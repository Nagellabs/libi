/**
 * Text in `tools/list` that points at things libi no longer has, and result
 * guidance that belongs in results rather than in every session's tool list.
 * Asserted on a REAL tools/list (a source scan passes against an empty list).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createLibiMcpServer } from "@/mcp/server";

let tools: Tool[];
const byName = (n: string) => tools.find((t) => t.name === n)!;

/** A tool's description plus every property description in its input schema. */
function allText(t: Tool): string {
  const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
  return [t.description ?? "", ...Object.values(props).map((p) => p.description ?? "")].join("\n");
}

beforeAll(async () => {
  const server = createLibiMcpServer({ surface: "in-app" });
  const client = new Client({ name: "t", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  tools = (await client.listTools()).tools;
  await client.close();
  await server.close();
});

describe("no tool text points at what libi no longer has", () => {
  it("canary: the list is real", () => {
    expect(tools.length).toBeGreaterThan(100);
  });

  it("names no tool that does not exist (libi.delete_scene and friends)", () => {
    const names = new Set(tools.map((t) => t.name));
    const offenders: string[] = [];
    for (const t of tools) {
      for (const m of allText(t).matchAll(/libi\.([a-z0-9_]+)/g)) {
        if (!names.has(`libi.${m[1]}`)) offenders.push(`${t.name} mentions libi.${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("cites no CLAUDE.md (libi writes none) and no base/video scene", () => {
    for (const t of tools) {
      const text = allText(t);
      expect(text, t.name).not.toMatch(/CLAUDE\.md/);
      expect(text, t.name).not.toMatch(/base scene|video scene|linkedSceneId/i);
    }
  });

  it("the timeline tools speak of overlays and audio clips, not scenes", () => {
    for (const n of [
      "libi.clip",
      "libi.audio_clip",
      "libi.layer_effect",
      "libi.snapshot",
      "libi.save_asset",
      "libi.music_detect_beats",
      "libi.delete_file",
      "libi.effect",
      "libi.audio_add_clip",
      "libi.show",
    ]) {
      expect(allText(byName(n)), n).not.toMatch(/\bscenes?\b/i);
    }
  });

  it("delete_file points at the tools that exist for removing a clip or overlay", () => {
    const text = allText(byName("libi.delete_file"));
    expect(text).toContain("libi.remove_overlay");
    expect(text).toContain("libi.audio_clip");
  });
});

describe("result-handling prose lives in results, not descriptions", () => {
  const JOB_TOOLS = [
    "libi.whisper_download_model",
    "libi.tts_download_model",
    "libi.music_download_model",
    "libi.generate_music",
    "libi.install_tracking_engine",
  ];

  it.each(JOB_TOOLS)("%s keeps one sentence about the job, not the dedup boilerplate", (n) => {
    const d = byName(n).description ?? "";
    expect(d).not.toContain("Dedup signals");
    expect(d).not.toContain("runs on the SERVER");
    expect(d).toContain('libi.job({ action: "list"'); // the one thing an interrupted call cannot get from a result
    expect(d.length).toBeLessThan(1000);
  });

  it("generate_music no longer defers to a CLAUDE.md heuristic and points at the result's note", () => {
    const d = byName("libi.generate_music").description ?? "";
    expect(d).not.toMatch(/CLAUDE\.md|heuristic/);
    expect(d).toContain("`note`");
  });

  it("export_video stays short, keeps what the agent needs BEFORE calling, and defers the rest to the result", () => {
    const d = byName("libi.export_video").description ?? "";
    expect(d.length).toBeLessThanOrEqual(1200);
    for (const rule of [
      "ALWAYS confirm",
      "`destFolder` is refused",
      "`purpose`",
      "`variants`",
      "graphicsQuality",
      "Chromium",
      "untrusted",
    ]) {
      expect(d, rule).toContain(rule);
    }
    // The result guidance moved to the result's `note` (exportGuidanceNote).
    for (const gone of ["cause: ", "unloadedFonts", "libi.regenerate_proxy", "audioDecision", "droppedOverlays"]) {
      expect(d, gone).not.toContain(gone);
    }
    expect(d).toContain("`note`");
  });

  it("export_video does not advertise destFolder", () => {
    expect(Object.keys(byName("libi.export_video").inputSchema.properties as object)).not.toContain("destFolder");
  });
});
