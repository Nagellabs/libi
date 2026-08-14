/**
 * `audioRelinkOverlay` (mcp/tools/audio-clip-tools.ts) was fully implemented
 * but never registered as an MCP tool — the agent could relink SCENE audio
 * via the retired libi.audio_relink_scene but had no overlay counterpart. This covers
 * both halves: the tool is actually registered on the core libi MCP, and the
 * underlying function behaves correctly when driven directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registeredToolNames } from "@/__tests__/helpers/mcp-tools";

let storageRoot: string;
let pieceDir: string;
const PIECE_ID = "p_relink_overlay";

vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-audio-relink-overlay-"));
  pieceDir = join(storageRoot, "storage", PIECE_ID);
  mkdirSync(pieceDir, { recursive: true });
});

afterEach(() => {
  rmSync(storageRoot, { recursive: true, force: true });
});

const ctx = () => ({ pieceId: PIECE_ID });

const writeManifest = (m: object) =>
  writeFileSync(join(pieceDir, "composition.json"), JSON.stringify(m), "utf-8");

const readManifest = () =>
  JSON.parse(readFileSync(join(pieceDir, "composition.json"), "utf-8"));

describe("libi.audio_relink_overlay registration", () => {
  it("is registered as an MCP tool on the core libi MCP", async () => {
    const { createLibiMcpServer } = await import("@/mcp/server");
    const server = createLibiMcpServer();
    const names = registeredToolNames(server);
    expect(names).toContain("libi.audio_relink_overlay");
  });
});

describe("audioRelinkOverlay", () => {
  it("re-attaches a standalone clip to a video overlay as inline audio", async () => {
    writeManifest({
      sceneOrder: [],
      width: 1920,
      height: 1080,
      fps: 30,
      overlays: [
        {
          id: "vid-1",
          kind: "video",
          startTime: 3,
          duration: 6,
          rect: { x: 0, y: 0, width: 1920, height: 1080 },
          z: 0,
          opacity: 1,
          fileId: "f1",
        },
      ],
      audioClips: [
        {
          id: "clip_1",
          kind: "standalone",
          fileId: "f1",
          startTime: 0,
          duration: 6,
          trimStart: 0,
          volume: 1,
          enabled: true,
        },
      ],
    });

    const { audioRelinkOverlay } = await import("@/mcp/tools/audio-clip-tools");
    const result = await audioRelinkOverlay(ctx(), {
      pieceId: PIECE_ID,
      clipId: "clip_1",
      overlayId: "vid-1",
    });
    expect(result.success).toBe(true);

    const clip = readManifest().audioClips[0];
    expect(clip).toMatchObject({
      kind: "inline",
      linkedOverlayId: "vid-1",
      startTime: 3,
      duration: 6,
    });
  });

  it("fails when the clip or the video overlay is missing", async () => {
    writeManifest({ sceneOrder: [], width: 1920, height: 1080, fps: 30, audioClips: [] });

    const { audioRelinkOverlay } = await import("@/mcp/tools/audio-clip-tools");
    const result = await audioRelinkOverlay(ctx(), {
      pieceId: PIECE_ID,
      clipId: "missing",
      overlayId: "also-missing",
    });
    expect(result.success).toBe(false);
  });
});
