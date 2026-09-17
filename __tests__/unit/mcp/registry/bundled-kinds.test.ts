import { describe, it, expect } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BUNDLED_MCP_SERVERS,
  EXTENSION_MCP_SERVERS,
  extensionForToolName,
} from "@/mcp/registry/bundled";
import { registerTrackingTools } from "@/mcp/tracking-mcp/register-tracking-tools";
import { createLibiMcpServer } from "@/mcp/server";
import { registeredToolNames } from "@/__tests__/helpers/mcp-tools";

describe("bundled def kinds", () => {
  it("gives every def a kind and a toolPrefixes array", () => {
    for (const def of BUNDLED_MCP_SERVERS) {
      expect(["core", "extension"]).toContain(def.kind);
      expect(Array.isArray(def.toolPrefixes)).toBe(true);
      // The legacy boolean and the new discriminator encode the same fact.
      expect(def.core === true, def.id).toBe(def.kind === "core");
    }
  });

  it("has exactly one core def, and it is libi", () => {
    const core = BUNDLED_MCP_SERVERS.filter((d) => d.kind === "core");
    expect(core.map((d) => d.id)).toEqual(["libi"]);
  });

  it("exposes every extension through EXTENSION_MCP_SERVERS", () => {
    expect(EXTENSION_MCP_SERVERS.every((d) => d.kind === "extension")).toBe(true);
    expect(EXTENSION_MCP_SERVERS.map((d) => d.id).sort()).toEqual(
      BUNDLED_MCP_SERVERS.filter((d) => d.kind === "extension").map((d) => d.id).sort(),
    );
  });

  it("ships no third-party def — libi bundles only its own extensions", () => {
    expect(BUNDLED_MCP_SERVERS.map((d) => d.id)).toEqual([
      "libi",
      "libi-export",
      "youtube-download",
      "libi-tracking",
      "whisper",
      "local-tts",
      "local-music",
    ]);
    for (const def of BUNDLED_MCP_SERVERS) {
      expect(def.type, def.id).toBe("stdio");
    }
  });

  it("gives every libi-owned extension at least one tool prefix", () => {
    for (const def of EXTENSION_MCP_SERVERS) {
      expect(def.toolPrefixes.length, def.id).toBeGreaterThan(0);
    }
  });

  it("routes a tool name to the extension that owns its prefix", () => {
    expect(extensionForToolName("libi.generate_music")?.id).toBe("local-music");
    expect(extensionForToolName("libi.music_download_model")?.id).toBe("local-music");
    expect(extensionForToolName("libi.compute_object_track")?.id).toBe("libi-tracking");
    expect(extensionForToolName("libi.whisper_list_models")?.id).toBe("whisper");
    expect(extensionForToolName("libi.export_video")?.id).toBe("libi-export");
    expect(extensionForToolName("libi.list_pieces")).toBeNull();
  });

  it("includes the Chromium export extension", () => {
    expect(EXTENSION_MCP_SERVERS.map((d) => d.id)).toContain("libi-export");
  });

  it("never assigns one tool prefix to two extensions, nor lets one extension's prefix cover another's", () => {
    const seen = new Map<string, string>();
    for (const def of EXTENSION_MCP_SERVERS) {
      for (const p of def.toolPrefixes) {
        expect(seen.has(p), `"${p}" declared by both ${seen.get(p)} and ${def.id}`).toBe(false);
        // Overlap (one extension's prefix is a prefix of another's) is deterministic
        // under extensionForToolName's longest-wins rule, but ownership of a name must
        // still be unambiguous — a shorter prefix must never reach into another
        // extension's namespace.
        for (const [other, owner] of seen) {
          if (owner === def.id) continue;
          expect(
            p.startsWith(other) || other.startsWith(p),
            `"${p}" (${def.id}) overlaps "${other}" (${owner})`,
          ).toBe(false);
        }
        seen.set(p, def.id);
      }
    }
  });

  // The prefix↔tool coupling above only ran one way: every registered
  // tool must land on the right extension. Nothing asserted the reverse, so a
  // prefix left behind by a REMOVED tool — the shape every removal on this
  // branch took — stayed in the def forever, silently. It is not inert: an
  // orphan prefix is live routing surface for `extensionForToolName`, which
  // decides the approval gate and the "which extension owns this?" answer, so
  // it can start gating a future tool that merely shares the prefix.
  it("has at least one registered tool behind every declared prefix", () => {
    // `createLibiMcpServer` registers the core tools AND calls
    // registerTrackingTools, so this is the complete libi.* surface an agent
    // sees — which is where every extension's tools actually live (the
    // standalone extension servers re-register the same functions).
    const registered = registeredToolNames(createLibiMcpServer());
    expect(registered.length).toBeGreaterThan(100);

    const orphans: string[] = [];
    for (const def of EXTENSION_MCP_SERVERS) {
      for (const prefix of def.toolPrefixes) {
        if (!registered.some((name) => name.startsWith(prefix))) {
          orphans.push(`${def.id}: "${prefix}"`);
        }
      }
    }
    expect(
      orphans,
      `these toolPrefixes match no registered tool — a removed tool left its prefix behind:\n  ${orphans.join("\n  ")}`,
    ).toEqual([]);
  });

  it("covers every tool registered on the tracking server", () => {
    // Same stub shape as __tests__/unit/tracking/identity-tools-registration.test.ts:
    // registerTrackingTools only calls server.registerTool(name, meta, handler).
    const registered: string[] = [];
    const stub = {
      registerTool: (name: string, _meta: unknown, _handler: unknown) => {
        registered.push(name);
      },
    } as unknown as McpServer;
    registerTrackingTools(stub);

    expect(registered.length).toBeGreaterThan(0);
    for (const name of registered) {
      expect(name.startsWith("libi.")).toBe(true);
      expect(extensionForToolName(name)?.id, name).toBe("libi-tracking");
    }
  });
});
