import { describe, it, expect, vi } from "vitest";
import { isGenerationTool } from "@/lib/approval/generation";
import { makeMcpToolId } from "@/lib/agents/mcp-tool-id";

vi.mock("@/mcp/registry/bundled", () => ({
  BUNDLED_MCP_SERVERS: [
    { id: "elevenlabs", generation: true },
    { id: "fal-ai", generation: true },
    { id: "youtube-downloader", generation: false },
    { id: "libi", generation: false },
  ],
}));

describe("isGenerationTool", () => {
  it("matches canonical IDs for generation MCPs", () => {
    expect(isGenerationTool(makeMcpToolId("elevenlabs", "generate_speech"))).toBe(true);
    expect(isGenerationTool(makeMcpToolId("fal-ai", "run_model"))).toBe(true);
  });

  it("returns false for non-generation MCPs", () => {
    expect(
      isGenerationTool(makeMcpToolId("youtube-downloader", "ytdlp_download_video")),
    ).toBe(false);
    expect(isGenerationTool(makeMcpToolId("libi", "libi.create_piece"))).toBe(false);
  });

  it("returns false for built-in (null) tool ids", () => {
    expect(isGenerationTool(null)).toBe(false);
  });

  it("returns false for unknown servers (canonical id with unregistered server)", () => {
    // Cast — we want to feed a malformed canonical id through the brand
    // type to verify the parse step rejects unknown servers.
    expect(
      isGenerationTool(makeMcpToolId("not-in-registry", "tool")),
    ).toBe(false);
  });
});
