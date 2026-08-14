import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadScenarioConfig } from "@/mcp/dev/fake-fal/config";

afterEach(() => { delete process.env.LIBI_FAKE_FAL_CONFIG; });

describe("loadScenarioConfig", () => {
  it("returns null when env var unset", () => {
    expect(loadScenarioConfig()).toBeNull();
  });

  it("parses a config file referenced by LIBI_FAKE_FAL_CONFIG", () => {
    const dir = mkdtempSync(join(tmpdir(), "fakefal-"));
    const p = join(dir, "scenario.json");
    writeFileSync(p, JSON.stringify({ recommend_model: { default: "fal-ai/flux-2-pro" } }));
    process.env.LIBI_FAKE_FAL_CONFIG = p;
    expect(loadScenarioConfig()?.recommend_model?.default).toBe("fal-ai/flux-2-pro");
  });

  it("returns null (not throw) when the file is missing or invalid", () => {
    process.env.LIBI_FAKE_FAL_CONFIG = "/nonexistent/scenario.json";
    expect(loadScenarioConfig()).toBeNull();
  });
});
