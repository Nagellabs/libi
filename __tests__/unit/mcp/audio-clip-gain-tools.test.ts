/**
 * B3 through a REAL server and MCP client: `libi.audio_clip({ action: "update", gainDb, crossfadeMs })`,
 * `libi.add_keyframe({ clipId, properties: { volumeDb } })` and `libi.keyframe` list / delete / set_easing on a
 * clip. (apply_ops carrying them: __tests__/integration/apply-ops-audio-gain.test.ts.) The curve itself is held by clip-gain.test.ts and the export
 * integration test; this file holds the tool surface and what lands in the manifest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let storageRoot: string;
vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));
vi.mock("@/mcp/jobs-client", () => ({
  getJobStatusFromServer: vi.fn(),
  listJobsFromServer: vi.fn(),
  cancelJobOnServer: vi.fn(),
  LibiServerUnavailableError: class extends Error { hint = ""; },
}));
vi.mock("@/mcp/tools/social-http", () => ({ api: vi.fn() }));

import { createLibiMcpServer } from "@/mcp/server";
import { splitClip } from "@/lib/composition/audio-clips";
import { loadManifest } from "@/lib/composition/persistence";

const PIECE = "p_gain";
const clips = () =>
  JSON.parse(readFileSync(join(storageRoot, "storage", PIECE, "composition.json"), "utf-8")).audioClips as Array<Record<string, unknown>>;

async function connect() {
  const server = createLibiMcpServer({ surface: "in-app" });
  const client = new Client({ name: "t", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return {
    call: async (name: string, args: Record<string, unknown>) => {
      const res = await client.callTool({ name, arguments: args });
      const text = (res.content as Array<{ text: string }>)[0].text;
      let json: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
      try { json = JSON.parse(text); } catch { /* plain-text refusal */ }
      return { isError: !!res.isError, text, json };
    },
    close: async () => { await client.close(); await server.close(); },
  };
}

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-gain-"));
  process.env.LIBI_HOME = storageRoot;
  mkdirSync(join(storageRoot, "storage", PIECE), { recursive: true });
  writeFileSync(
    join(storageRoot, "storage", PIECE, "composition.json"),
    JSON.stringify({
      width: 1920, height: 1080, fps: 30,
      overlays: [
        { id: "text-1", kind: "text", startTime: 0, duration: 4, rect: { x: 0, y: 0, width: 100, height: 50 }, z: 1, opacity: 1, content: "hi", font: "32px Inter", color: "#fff", align: "center" },
      ],
      audioClips: [
        { id: "bed", kind: "standalone", fileId: "f-song", startTime: 0, duration: 30, trimStart: 0, volume: 1, enabled: true },
        { id: "bed2", kind: "standalone", fileId: "f-song", startTime: 29.9, duration: 30, trimStart: 40, volume: 1, enabled: true },
      ],
    }),
  );
});
afterEach(() => {
  rmSync(storageRoot, { recursive: true, force: true });
  delete process.env.LIBI_HOME;
  vi.restoreAllMocks();
});

describe("gainDb and crossfadeMs on libi.audio_clip", () => {
  it("sets the gain in dB beside volume, and 0 clears it", async () => {
    const h = await connect();
    const set = await h.call("libi.audio_clip", { action: "update", pieceId: PIECE, clipId: "bed", gainDb: 3.8 });
    expect(set.json).toMatchObject({ success: true, data: { clipId: "bed", gainDb: 3.8 } });
    expect(clips()[0]).toMatchObject({ gainDb: 3.8, volume: 1 });
    await h.call("libi.audio_clip", { action: "update", pieceId: PIECE, clipId: "bed", gainDb: 0 });
    expect("gainDb" in clips()[0]).toBe(false);
    await h.close();
  });

  it("refuses a gain outside -60..+12", async () => {
    const h = await connect();
    const bad = await h.call("libi.audio_clip", { action: "update", pieceId: PIECE, clipId: "bed", gainDb: 20 });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("gainDb");
    await h.close();
  });

  it("sets a crossfade; with no overlapping earlier clip of the file it says it does nothing yet", async () => {
    const h = await connect();
    const ok = await h.call("libi.audio_clip", { action: "update", pieceId: PIECE, clipId: "bed2", crossfadeMs: 80 });
    expect(ok.json.success).toBe(true);
    expect(ok.json.data.note).toBeUndefined(); // bed2 overlaps bed's last 100 ms
    expect(clips()[1]).toMatchObject({ crossfadeMs: 80 });
    // moving it off the overlap breaks the crossfade, and the update says so
    const idle = await h.call("libi.audio_clip", { action: "update", pieceId: PIECE, clipId: "bed2", startTime: 40 });
    expect(idle.json.success).toBe(true);
    expect(idle.json.data.note).toContain("no earlier clip of the same file");
    await h.close();
  });
});

describe("volume keyframes through libi.add_keyframe / libi.keyframe", () => {
  const keys = () => (clips()[0].volumeKeyframes as { keyframes: Array<{ t: number; value: number; easing?: string }> } | undefined)?.keyframes;

  it("adds dB-offset keys at clip-local seconds, replaces one near an existing key, and lists them", async () => {
    const h = await connect();
    expect((await h.call("libi.add_keyframe", { pieceId: PIECE, clipId: "bed", time: 4, properties: { volumeDb: 0 } })).json.success).toBe(true);
    const dip = await h.call("libi.add_keyframe", { pieceId: PIECE, clipId: "bed", time: 6, properties: { volumeDb: -12 }, easing: "ease-in-out" });
    expect(dip.json).toMatchObject({ success: true, data: { clipId: "bed", time: 6, volumeDb: -12, easing: "ease-in-out" } });
    await h.call("libi.add_keyframe", { pieceId: PIECE, clipId: "bed", time: 6.002, properties: { volumeDb: -9 } });
    expect(keys()).toEqual([{ t: 4, value: 0 }, { t: 6, value: -9, easing: "ease-in-out" }]);
    const list = await h.call("libi.keyframe", { action: "list", pieceId: PIECE, clipId: "bed" });
    expect(list.json.data).toMatchObject({ clipId: "bed", duration: 30, times: [4, 6], tracks: { volumeDb: [{ time: 4, db: 0 }, { time: 6, db: -9, easing: "ease-in-out" }] } });
    await h.close();
  });

  it("re-eases and deletes a key; deleting the last one drops the envelope", async () => {
    const h = await connect();
    await h.call("libi.add_keyframe", { pieceId: PIECE, clipId: "bed", time: 4, properties: { volumeDb: 0 } });
    await h.call("libi.add_keyframe", { pieceId: PIECE, clipId: "bed", time: 8, properties: { volumeDb: -12 } });
    expect((await h.call("libi.keyframe", { action: "set_easing", pieceId: PIECE, clipId: "bed", time: 4, easing: "ease-out" })).json.success).toBe(true);
    expect(keys()![0]).toMatchObject({ t: 4, easing: "ease-out" });
    expect((await h.call("libi.keyframe", { action: "set_easing", pieceId: PIECE, clipId: "bed", time: 5, easing: "ease-out" })).json.error).toContain("no keyframe at 5s");
    expect((await h.call("libi.keyframe", { action: "set_easing", pieceId: PIECE, clipId: "bed", time: 4, easing: "wobble" })).json.error).toContain("invalid easing");
    expect((await h.call("libi.keyframe", { action: "delete", pieceId: PIECE, clipId: "bed", time: 4 })).json.success).toBe(true);
    expect((await h.call("libi.keyframe", { action: "delete", pieceId: PIECE, clipId: "bed", time: 8 })).json.success).toBe(true);
    expect("volumeKeyframes" in clips()[0]).toBe(false);
    await h.close();
  });

  it("refuses what a clip cannot key, a time past the clip, and a target that is both or neither", async () => {
    const h = await connect();
    const other = await h.call("libi.add_keyframe", { pieceId: PIECE, clipId: "bed", time: 1, properties: { volumeDb: -3, opacity: 0.5 } });
    expect(other.json.error).toContain("volumeDb only");
    const none = await h.call("libi.add_keyframe", { pieceId: PIECE, clipId: "bed", time: 1 });
    expect(none.json.error).toContain("volumeDb");
    const late = await h.call("libi.add_keyframe", { pieceId: PIECE, clipId: "bed", time: 31, properties: { volumeDb: 0 } });
    expect(late.json.error).toContain("out of range");
    const both = await h.call("libi.add_keyframe", { pieceId: PIECE, clipId: "bed", overlayId: "text-1", time: 1, properties: { volumeDb: 0 } });
    expect(both.json.error).toContain("OR");
    const neither = await h.call("libi.keyframe", { action: "list", pieceId: PIECE });
    expect(neither.json.error).toContain("clipId");
    const onOverlay = await h.call("libi.add_keyframe", { pieceId: PIECE, overlayId: "text-1", time: 1, properties: { volumeDb: -3 } });
    expect(onOverlay.json.error).toContain("AUDIO clip");
    const out = await h.call("libi.add_keyframe", { pieceId: PIECE, clipId: "bed", time: 1, properties: { volumeDb: -80 } });
    expect(out.isError).toBe(true); // below -60: the schema refuses
    await h.close();
  });

  it("an overlay keyframe still works the same", async () => {
    const h = await connect();
    const r = await h.call("libi.add_keyframe", { pieceId: PIECE, overlayId: "text-1", time: 1, properties: { opacity: 0.5 } });
    expect(r.json.success).toBe(true);
    const l = await h.call("libi.keyframe", { action: "list", pieceId: PIECE, overlayId: "text-1" });
    expect(l.json.data.tracks.opacity).toHaveLength(1);
    await h.close();
  });
});

describe("split keeps what each half played", () => {
  it("cuts the envelope and hands the crossfade to the head only", async () => {
    const m = await loadManifest(PIECE);
    m.audioClips![1].crossfadeMs = 80;
    m.audioClips![1].volumeKeyframes = { keyframes: [{ t: 2, value: 0 }, { t: 6, value: -12 }] };
    const next = splitClip(m, "bed2", 29.9 + 4)!;
    const head = next.audioClips!.find((c) => c.id === "bed2")!;
    const tail = next.audioClips!.find((c) => c.id !== "bed" && c.id !== "bed2")!;
    expect(head.crossfadeMs).toBe(80);
    expect(tail.crossfadeMs).toBeUndefined();
    expect(tail.volumeKeyframes!.keyframes[0]).toMatchObject({ t: 0, value: -6 });
    expect(tail.volumeKeyframes!.keyframes.at(-1)).toMatchObject({ t: 2, value: -12 });
  });
});
