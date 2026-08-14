import { describe, it, expect } from "vitest";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

describe("mediapipe-vision dep", () => {
  it("is declared on the libi MCP with correct version + structure", () => {
    const libi = BUNDLED_MCP_SERVERS.find((d) => d.id === "libi")!;
    const mp = libi.dependencies.find((d) => d.binary === "mediapipe-vision");
    expect(mp).toBeTruthy();
    expect(mp!.destination).toBe("models");
    expect(mp!.files!.length).toBe(7);
    expect(mp!.files!.every((f) => /^[0-9a-f]{64}$/.test(f.sha256 ?? ""))).toBe(true);

    // All wasm URLs must reference the pinned tasks-vision version
    const wasmFiles = mp!.files!.filter((f) => f.relPath.startsWith("wasm/"));
    expect(wasmFiles).toHaveLength(4);
    expect(wasmFiles.every((f) => f.url.includes("@mediapipe/tasks-vision@0.10.35"))).toBe(true);

    // Expected relPath structure — track-entry queries `${BASE}/mediapipe-vision/wasm/...` and `.../models/...`
    // Includes blaze_face_short_range.tflite for two-stage face detection pipeline.
    const expectedRelPaths = new Set([
      "wasm/vision_wasm_internal.wasm",
      "wasm/vision_wasm_internal.js",
      "wasm/vision_wasm_nosimd_internal.wasm",
      "wasm/vision_wasm_nosimd_internal.js",
      "models/face_landmarker.task",
      "models/blaze_face_short_range.tflite",
      "models/efficientdet_lite0.tflite",
    ]);
    expect(new Set(mp!.files!.map((f) => f.relPath))).toEqual(expectedRelPaths);

    // Model URLs must NOT use /latest/ — pin versions for reproducible installs
    const modelFiles = mp!.files!.filter((f) => f.relPath.startsWith("models/"));
    expect(modelFiles.every((f) => !f.url.includes("/latest/"))).toBe(true);
  });

  it("track-entry.ts asserts modelBaseUrl is injected", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.join(process.cwd(), "lib/tracking/track-entry.ts"), "utf-8");
    // Must read from __libiTrackConfig
    expect(src).toMatch(/__libiTrackConfig/);
    // Must explicitly throw when missing
    expect(src).toMatch(/modelBaseUrl[\s\S]{0,80}throw/);
  });

  it("mediapipe-runner injects modelBaseUrl via addInitScript before page.goto", async () => {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const src = await fs.readFile(path.join(process.cwd(), "lib/tracking/mediapipe-runner.ts"), "utf-8");
    const addInitIdx = src.indexOf("addInitScript");
    const gotoIdx = src.indexOf("page.goto");
    expect(addInitIdx).toBeGreaterThan(0);
    expect(gotoIdx).toBeGreaterThan(0);
    expect(addInitIdx).toBeLessThan(gotoIdx);
    // Must inject modelBaseUrl
    expect(src).toMatch(/modelBaseUrl/);
  });
});
