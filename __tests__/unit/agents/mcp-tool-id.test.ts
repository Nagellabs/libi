import { describe, it, expect } from "vitest";
import {
  makeMcpToolId,
  parseMcpToolId,
  fromAnyToolName,
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
    expect(fromAnyToolName("mcp__YouTube_Downloader__ytdlp_search_videos")).toBe(
      "youtube-downloader:ytdlp_search_videos",
    );
    expect(fromAnyToolName("mcp__ElevenLabs__text_to_speech")).toBe(
      "elevenlabs:text_to_speech",
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
