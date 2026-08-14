import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { STATIC_BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

describe("whisper + local-tts versioning retrofit (post QA-FIX-A)", () => {
  it("whisper row no longer carries a legacy files[] model dep", () => {
    // The whisper-model status/version is now owned by the
    // `whisper-model` virtual dep (lib/mcp-virtual-deps/whisper.ts).
    // Settings UI used to render two chips per model (legacy
    // BundledDependency + virtual dep); QA-FIX-A removed the legacy row.
    const def = STATIC_BUNDLED_MCP_SERVERS.find((d) => d.id === "whisper")!;
    const model = def.dependencies.find((d) => d.destination === "models");
    expect(model).toBeUndefined();
  });

  it("local-tts row no longer carries a legacy files[] model dep", () => {
    const def = STATIC_BUNDLED_MCP_SERVERS.find((d) => d.id === "local-tts")!;
    const model = def.dependencies.find((d) => d.destination === "models");
    expect(model).toBeUndefined();
  });

  it("tts download runner still writes the install-token marker", () => {
    const src = readFileSync(
      resolve("lib/jobs/runners/tts-model-download.ts"),
      "utf-8",
    );
    expect(src).toMatch(/install-token|writeInstall/i);
  });
});
