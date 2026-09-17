import { describe, it, expect } from "vitest";
import {
  makeMcpToolId,
  parseMcpToolId,
  fromAnyToolName,
  fromCodexToolCall,
  type McpToolId,
} from "@/lib/agents/mcp-tool-id";

describe("makeMcpToolId", () => {
  it("concatenates server-id and tool-name with a colon", () => {
    const id = makeMcpToolId("libi", "libi.compute_object_track");
    expect(id).toBe("libi:libi.compute_object_track");
  });
  it("preserves dashes and dots verbatim", () => {
    expect(makeMcpToolId("libi-tracking", "libi.compute_object_track")).toBe(
      "libi-tracking:libi.compute_object_track",
    );
    expect(makeMcpToolId("elevenlabs", "speech_to_text")).toBe(
      "elevenlabs:speech_to_text",
    );
  });
  it("throws on empty server or tool", () => {
    expect(() => makeMcpToolId("", "foo")).toThrow();
    expect(() => makeMcpToolId("libi", "")).toThrow();
  });
});

describe("parseMcpToolId", () => {
  it("round-trips with makeMcpToolId", () => {
    const id = makeMcpToolId("libi", "libi.compute_object_track");
    const parsed = parseMcpToolId(id);
    expect(parsed).toEqual({ serverId: "libi", toolName: "libi.compute_object_track" });
  });
  it("handles colons inside the tool name (only the first colon splits)", () => {
    const id = "libi:weird:tool" as McpToolId;
    expect(parseMcpToolId(id)).toEqual({ serverId: "libi", toolName: "weird:tool" });
  });
  it("returns null for malformed input", () => {
    expect(parseMcpToolId("")).toBeNull();
    expect(parseMcpToolId("no-colon")).toBeNull();
    expect(parseMcpToolId(":empty-server")).toBeNull();
    expect(parseMcpToolId("empty-tool:")).toBeNull();
  });
});

describe("fromAnyToolName", () => {
  it("returns canonical form unchanged", () => {
    expect(fromAnyToolName("libi:libi.compute_object_track")).toBe(
      "libi:libi.compute_object_track",
    );
  });
  it("converts wire form mcp__server__tool with dot inside tool", () => {
    expect(fromAnyToolName("mcp__libi__libi.compute_object_track")).toBe(
      "libi:libi.compute_object_track",
    );
  });
  it("converts wire form mcp__server__tool with underscore (recovers dot)", () => {
    expect(fromAnyToolName("mcp__libi__libi_analysis_describe_frame")).toBe(
      "libi:libi.analysis_describe_frame",
    );
  });
  it("handles hyphenated server ids (mcp__libi-tracking__...)", () => {
    expect(fromAnyToolName("mcp__libi-tracking__libi.compute_object_track")).toBe(
      "libi-tracking:libi.compute_object_track",
    );
  });
  it("handles non-libi MCPs (no underscore-to-dot recovery needed)", () => {
    expect(fromAnyToolName("mcp__elevenlabs__speech_to_text")).toBe(
      "elevenlabs:speech_to_text",
    );
    expect(fromAnyToolName("mcp__youtube-downloader__ytdlp_download_audio")).toBe(
      "youtube-downloader:ytdlp_download_audio",
    );
  });
  it("returns null for unknown shapes", () => {
    expect(fromAnyToolName("")).toBeNull();
    expect(fromAnyToolName("Read /some/path")).toBeNull();
    expect(fromAnyToolName("ToolSearch")).toBeNull();
  });
  // The ACP mcpServers config keys servers by their display NAME (row.name),
  // not the bundled id — Claude Code then builds the wire name from that key
  // with spaces flattened to underscores. Canonicalization must bridge the
  // two so bundled servers always resolve to their bundled id.
  it("resolves a bundled server registered under its display name", () => {
    expect(fromAnyToolName("mcp__Whisper_(local_STT)__whisper_transcribe")).toBe(
      "whisper:whisper_transcribe",
    );
    expect(fromAnyToolName("mcp__Local_TTS_(Kokoro)__tts_list_voices")).toBe(
      "local-tts:tts_list_voices",
    );
    // A user's own provider MCP is not a bundled def: its segment passes
    // through untouched (libi bundles no third-party MCP).
    expect(fromAnyToolName("mcp__ElevenLabs__text_to_speech")).toBe(
      "ElevenLabs:text_to_speech",
    );
    expect(fromAnyToolName("mcp__fal-ai__generate_image")).toBe(
      "fal-ai:generate_image",
    );
  });
  it("recovers libi dots when libi-tracking arrives under its display name", () => {
    expect(fromAnyToolName("mcp__Libi_Tracking__libi_compute_object_track")).toBe(
      "libi-tracking:libi.compute_object_track",
    );
  });
  // Users install their own MCPs — formatting and gating must never depend
  // on libi knowing the server. Unknown servers canonicalize verbatim.
  it("canonicalizes unknown (user-installed) servers verbatim", () => {
    expect(fromAnyToolName("mcp__My_Custom_MCP__do_thing")).toBe(
      "My_Custom_MCP:do_thing",
    );
    expect(fromAnyToolName("mcp__nonexistent__foo")).toBe("nonexistent:foo");
  });
  it("splits unknown servers at the FIRST double-underscore", () => {
    expect(fromAnyToolName("mcp__weird__tool__name")).toBe("weird:tool__name");
  });
  it("returns null for wire names with no server/tool separator", () => {
    expect(fromAnyToolName("mcp__solo")).toBeNull();
    expect(fromAnyToolName("mcp__")).toBeNull();
    expect(fromAnyToolName("mcp__server__")).toBeNull();
  });
});

// The in-app ACP entry is registered as `libi-app` (lib/mcp-config.ts
// #IN_APP_MCP_NAME) so it can never collide with the `[mcp_servers.libi]`
// that `libi connect` writes into the user's codex config. Both agents
// prefix wire names with that entry name, so the segment must resolve back
// to the ONE canonical server id (`libi`) — every id-keyed check downstream
// (the jobs progress bridge, tool labels, the approval gate) compares
// against ids declared as makeMcpToolId("libi", …).
describe("the in-app server alias", () => {
  it("canonicalizes the libi-app wire name to the libi server id", () => {
    expect(fromAnyToolName("mcp__libi-app__libi_generate_music")).toBe("libi:libi.generate_music");
    expect(fromAnyToolName("mcp__libi_app__libi_show_in_chat")).toBe("libi:libi.show_in_chat");
  });

  it("keeps a dotted tool half intact under the alias", () => {
    expect(fromAnyToolName("mcp__libi-app__libi.get_composition")).toBe("libi:libi.get_composition");
  });

  // The shape codex-acp 1.10.0 ACTUALLY emits — `mcp.<entry>.<tool>` — and the
  // older adapter's `<entry>/<tool>`. Both must land on the SAME id the claude
  // wire name above produces, because that id is what the jobs progress
  // bridge, the approval gate and the tool labels all key on.
  //
  // These two cases used to read `Tool: libi-app/libi-app.libi.list_pieces`
  // and `libi-app/libi.list_pieces`: an invented doubled-entry title, and a
  // shape no adapter has emitted. They passed while every real codex MCP call
  // canonicalized to null. Never assert a wire shape that was not captured.
  it("canonicalizes the codex title forms too", () => {
    expect(fromAnyToolName("mcp.libi-app.libi.list_pieces")).toBe("libi:libi.list_pieces");
    expect(fromAnyToolName("mcp.libi.libi.list_pieces")).toBe("libi:libi.list_pieces");
    expect(fromAnyToolName("Tool: libi-app/libi.list_pieces")).toBe("libi:libi.list_pieces");
  });

  // …and the structured payload beside that title, which is the path the
  // ingest actually takes (`toolIdForCall`).
  it("canonicalizes the codex structured payload to the same id", () => {
    expect(
      fromCodexToolCall({ server: "libi-app", tool: "libi.list_pieces", arguments: {} }),
    ).toBe("libi:libi.list_pieces");
    expect(
      fromCodexToolCall({ server: "libi", tool: "libi.list_pieces", arguments: {} }),
    ).toBe("libi:libi.list_pieces");
  });

  it("still canonicalizes the connect name", () => {
    expect(fromAnyToolName("mcp__libi__libi_list_pieces")).toBe("libi:libi.list_pieces");
  });

  it("does not alias servers that merely start with libi", () => {
    expect(fromAnyToolName("mcp__libi-application__do_thing")).toBe("libi-application:do_thing");
  });

  it("never resolves an alias through Object.prototype", () => {
    // A user could name an MCP `constructor`; a bare index into the alias
    // map would hand back Object's constructor function as the server id.
    expect(fromAnyToolName("mcp__constructor__do_thing")).toBe("constructor:do_thing");
    expect(fromAnyToolName("mcp__toString__do_thing")).toBe("toString:do_thing");
  });
});
