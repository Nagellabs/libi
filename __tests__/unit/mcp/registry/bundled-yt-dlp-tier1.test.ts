import { describe, it, expect } from "vitest";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

describe("yt-dlp dep is flagged tier-1", () => {
  it("youtube-downloader.dependencies includes yt-dlp with installFlow=tier-1", () => {
    const yt = BUNDLED_MCP_SERVERS.find((m) => m.id === "youtube-downloader");
    expect(yt).toBeDefined();
    const ytDlpDep = yt!.dependencies.find((d) => d.binary === "yt-dlp");
    expect(ytDlpDep).toBeDefined();
    expect(ytDlpDep!.installFlow).toBe("tier-1");
  });

  it("filtering deps by tier-1 surfaces yt-dlp from a tier-2 MCP", () => {
    const allTier1Deps = BUNDLED_MCP_SERVERS.flatMap((m) =>
      m.dependencies.filter((d) => (d.installFlow ?? "tier-2") === "tier-1"),
    );
    const binaries = allTier1Deps.map((d) => d.binary);
    expect(binaries).toContain("yt-dlp");
  });
});
