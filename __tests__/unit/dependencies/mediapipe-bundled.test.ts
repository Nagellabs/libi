import { describe, it, expect } from "vitest";
import { BUNDLED_MCP_SERVERS } from "@/mcp/registry/bundled";

describe("mediapipe-vision dep", () => {
  it("is declared on libi-tracking as tier-2 with correct version + structure", () => {
    // Moved off the `libi` core def on 2026-09-08: 33 MB nobody
    // who never tracks an object should pay at boot. It is NOT gated behind
    // tracking-pyenv — `ensureDep("libi-tracking", "mediapipe-vision")`
    // installs this one dep alone, which is what the tracker runs first.
    const libi = BUNDLED_MCP_SERVERS.find((d) => d.id === "libi")!;
    expect(libi.dependencies.some((d) => d.binary === "mediapipe-vision")).toBe(false);
    const tracking = BUNDLED_MCP_SERVERS.find((d) => d.id === "libi-tracking")!;
    const mp = tracking.dependencies.find((d) => d.binary === "mediapipe-vision");
    expect(mp).toBeTruthy();
    expect(mp!.installFlow).toBe("tier-2");
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

  // The "installs the assets itself before launching Chromium" behaviour is
  // covered behaviourally in __tests__/unit/tracking/mediapipe-runner-ensure-dep.test.ts.
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
