/**
 * The resolver that can tell whether a text overlay's font FAMILY will
 * actually render, and the warning `saveManifest` emits when it won't — see
 * `lib/fonts/bundled.ts` for the bug this whole slice exists to catch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/lib/logger", () => {
  const warn = vi.fn();
  const logger = { info: () => {}, warn, error: () => {}, child: vi.fn(() => logger) };
  return { serverLogger: logger, mcpLogger: logger };
});

import { familyFromFont, isFamilyAvailable, unresolvedFamilies } from "@/lib/fonts/resolve";
import { saveManifest, type CompositionManifest } from "@/lib/composition/persistence";
import { serverLogger } from "@/lib/logger";

describe("familyFromFont", () => {
  it("pulls the family out of a shorthand", () => {
    expect(familyFromFont("800 120px Inter")).toBe("Inter");
    expect(familyFromFont("48px 'JetBrains Mono'")).toBe("JetBrains Mono");
    expect(familyFromFont('bold 32px "Helvetica Neue", sans-serif')).toBe("Helvetica Neue");
  });
  it("returns null when there is no parseable size", () => {
    expect(familyFromFont("Inter")).toBeNull();
  });
});

describe("isFamilyAvailable", () => {
  it("accepts bundled families", () => {
    expect(isFamilyAvailable("Inter")).toBe(true);
    expect(isFamilyAvailable("JetBrains Mono")).toBe(true);
  });
  it("accepts generic CSS keywords — they are not families", () => {
    for (const k of ["sans-serif", "serif", "monospace", "system-ui", "ui-monospace"]) {
      expect(isFamilyAvailable(k), k).toBe(true);
    }
  });
  it("rejects a family that does not exist", () => {
    expect(isFamilyAvailable("LibiNonexistentFontXYZ")).toBe(false);
  });
});

describe("unresolvedFamilies", () => {
  it("reports each missing family once, in order", () => {
    expect(
      unresolvedFamilies(["800 120px Inter", "48px GhostFaceA", "12px GhostFaceA", "20px GhostFaceB"]),
    ).toEqual(["GhostFaceA", "GhostFaceB"]);
  });
  it("is empty when everything resolves", () => {
    expect(unresolvedFamilies(["800 120px Inter", "20px monospace"])).toEqual([]);
  });
});

describe("saveManifest — unresolvable font warning", () => {
  let storageRoot: string;
  const PIECE_ID = "p_font_warn";

  beforeEach(() => {
    vi.clearAllMocks();
    storageRoot = mkdtempSync(join(tmpdir(), "libi-font-warn-"));
    process.env.LIBI_HOME = storageRoot;
  });

  afterEach(() => {
    delete process.env.LIBI_HOME;
    rmSync(storageRoot, { recursive: true, force: true });
  });

  it("warns once per save on a ghost family and leaves font byte-identical", async () => {
    const manifest: CompositionManifest = {
      width: 1920,
      height: 1080,
      fps: 30,
      overlays: [
        {
          id: "o1",
          kind: "text",
          startTime: 0,
          duration: 1,
          rect: { x: 0, y: 0, width: 100, height: 100 },
          z: 0,
          opacity: 1,
          content: "hi",
          font: "48px GhostFaceA",
          color: "#fff",
          align: "left",
        },
      ],
    };

    await saveManifest(PIECE_ID, manifest);

    expect(serverLogger.warn).toHaveBeenCalledTimes(1);
    const [payload, message] = (serverLogger.warn as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(payload.families).toEqual(["GhostFaceA"]);
    expect(payload.pieceId).toBe(PIECE_ID);
    expect(payload.overlayIds).toEqual(["o1"]);
    expect(String(message)).toMatch(/fallback face/);

    // Warn, never rewrite — silent substitution is the bug this exists to catch.
    // PersistedOverlay is a union; only the text member carries `font`.
    const saved = manifest.overlays![0] as { kind: string; font: string };
    expect(saved.font).toBe("48px GhostFaceA");
  });

  it("does not warn when every text overlay's font resolves", async () => {
    const manifest: CompositionManifest = {
      width: 1920,
      height: 1080,
      fps: 30,
      overlays: [
        {
          id: "o1",
          kind: "text",
          startTime: 0,
          duration: 1,
          rect: { x: 0, y: 0, width: 100, height: 100 },
          z: 0,
          opacity: 1,
          content: "hi",
          font: "48px Inter",
          color: "#fff",
          align: "left",
        },
      ],
    };

    await saveManifest(PIECE_ID, manifest);

    expect(serverLogger.warn).not.toHaveBeenCalled();
  });
});
