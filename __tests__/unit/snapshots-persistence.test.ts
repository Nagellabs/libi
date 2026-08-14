import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import { createTempStorageDir, cleanupTempDir } from "../helpers/test-storage";
import {
  saveCurrentSnapshot,
  loadCurrentSnapshot,
  pushSnapshotToHistory,
  listSnapshotHistory,
  loadHistorySnapshot,
  removeHistorySnapshot,
  HISTORY_RING_SIZE,
} from "@/lib/composition/snapshots";
import { getLibiStorageDir } from "@/lib/libi-home";
import type { CompositionManifest } from "@/lib/composition/persistence";

const emptyManifest = (): CompositionManifest => ({
  sceneOrder: [], width: 1920, height: 1080, fps: 30, audioClips: [], scenes: [],
});

describe("snapshots — current.json", () => {
  beforeEach(() => createTempStorageDir());
  afterEach(() => cleanupTempDir());

  it("save+load roundtrips", async () => {
    const pieceId = "p1";
    await saveCurrentSnapshot(pieceId, emptyManifest());
    const loaded = await loadCurrentSnapshot(pieceId);
    expect(loaded).not.toBeNull();
    expect(loaded?.sceneOrder).toEqual([]);
  });

  it("returns null when no snapshot exists", async () => {
    expect(await loadCurrentSnapshot("missing")).toBeNull();
  });
});

describe("snapshots — history ring buffer", () => {
  beforeEach(() => createTempStorageDir());
  afterEach(() => cleanupTempDir());

  it("pushSnapshotToHistory writes file + updates index", async () => {
    const id = await pushSnapshotToHistory("p1", emptyManifest(), { summary: "test", actor: "agent" });
    expect(id).toMatch(/^snap-/);
    const history = await listSnapshotHistory("p1");
    expect(history).toHaveLength(1);
    expect(history[0].id).toBe(id);
    expect(history[0].summary).toBe("test");
  });

  it("evicts oldest when >HISTORY_RING_SIZE entries pushed", async () => {
    for (let i = 0; i < HISTORY_RING_SIZE + 3; i++) {
      await pushSnapshotToHistory("p2", emptyManifest(), { summary: `s${i}`, actor: "user" });
    }
    const history = await listSnapshotHistory("p2");
    expect(history).toHaveLength(HISTORY_RING_SIZE);
    expect(history[0].summary).toBe(`s${HISTORY_RING_SIZE + 2}`); // newest first
    expect(history[history.length - 1].summary).toBe("s3"); // oldest survivor
  });

  it("loadHistorySnapshot returns manifest by id", async () => {
    const id = await pushSnapshotToHistory(
      "p3",
      { ...emptyManifest(), fps: 60 },
      { summary: "x", actor: "agent" },
    );
    const loaded = await loadHistorySnapshot("p3", id);
    expect(loaded?.fps).toBe(60);
  });

  it("removeHistorySnapshot evicts by id", async () => {
    const id1 = await pushSnapshotToHistory("p4", emptyManifest(), { summary: "1", actor: "user" });
    const id2 = await pushSnapshotToHistory("p4", emptyManifest(), { summary: "2", actor: "user" });
    await removeHistorySnapshot("p4", id1);
    const history = await listSnapshotHistory("p4");
    expect(history.map((h) => h.id)).toEqual([id2]);
  });
});
