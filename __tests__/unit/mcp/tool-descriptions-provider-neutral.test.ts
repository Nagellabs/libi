import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ENDPOINT_VENDORS } from "@/scripts/skill-eval/audit-endpoints";

/**
 * A tool description is read BEFORE the agent opens the skill, so a provider endpoint named there is the
 * higher-impact copy of a fact the skill keeps in its provider reference. The provider layer is where
 * endpoint ids live; the tools libi itself registers do not name one.
 */
describe("MCP tool descriptions name no provider endpoint", () => {
  const repoRoot = path.resolve(__dirname, "../../..");
  const SURFACES = [
    "mcp/server.ts",
    "mcp/tools/schemas.ts",
    "mcp/tracking-mcp/register-tracking-tools.ts",
    "lib/jobs/runners/matte-gen.ts",
  ];

  it("no vendor-prefixed endpoint id appears in an agent-facing description", () => {
    const re = new RegExp(`\\b(?:${ENDPOINT_VENDORS.join("|")})/[a-zA-Z0-9/_.-]+`, "g");
    for (const rel of SURFACES) {
      const text = readFileSync(path.join(repoRoot, rel), "utf8");
      const hits = [...text.matchAll(re)].map((m) => m[0]).filter((h) => h !== "fal-ai/ElevenLabs");
      expect(hits, `${rel} names provider endpoint ids: ${hits.join(", ")}`).toEqual([]);
    }
  });

  it("no paid-path model name survives where the skill split removed it", () => {
    // Seedance is NOT on this list on purpose: server.ts / schemas.ts / ffmpeg-tools.ts name it for an AUDIO
    // CONTAINER constraint (@Audio1 takes MP3/WAV, not AAC), a codec fact rather than a routing decision.
    const moved = ["birefnet", "bria", "gpt-image", "lucy-restyle", "latentsync", "sync-lipsync"];
    for (const rel of SURFACES) {
      const text = readFileSync(path.join(repoRoot, rel), "utf8").toLowerCase();
      for (const name of moved) {
        expect(text.includes(name), `${rel} still names "${name}"`).toBe(false);
      }
    }
  });
});
