import fs from "node:fs";
import path from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import { getStorage } from "@/lib/storage";
import { compositionChangedAtMs } from "@/lib/composition/changed-at";

/**
 * "When did this piece last change?" — what `libi.post_piece` compares an
 * export's start time with before reusing it. The draft is composition.json
 * PLUS each code overlay's body file (the agent edits `codeFilePath`
 * directly; composition.json never holds code), so both count.
 */
describe("compositionChangedAtMs", () => {
  let pieceId: string;
  let dir: string;
  beforeEach(async () => {
    pieceId = `changed-at-${Math.random().toString(36).slice(2)}`;
    const storage = await getStorage();
    dir = path.dirname(storage.localPath(pieceId, "composition.json"));
    fs.mkdirSync(dir, { recursive: true });
  });

  it("null for a piece that never saved a composition", async () => {
    expect(await compositionChangedAtMs(pieceId)).toBeNull();
  });

  it("the composition's own mtime when nothing else is newer", async () => {
    const f = path.join(dir, "composition.json");
    fs.writeFileSync(f, "{}");
    fs.utimesSync(f, new Date("2026-09-20T10:00:00Z"), new Date("2026-09-20T10:00:00Z"));
    expect(await compositionChangedAtMs(pieceId)).toBe(Date.parse("2026-09-20T10:00:00Z"));
  });

  it("an overlay code file edited after the composition counts", async () => {
    const f = path.join(dir, "composition.json");
    fs.writeFileSync(f, "{}");
    fs.utimesSync(f, new Date("2026-09-20T10:00:00Z"), new Date("2026-09-20T10:00:00Z"));
    const code = path.join(dir, "overlays", "ov-1", "draw.js");
    fs.mkdirSync(path.dirname(code), { recursive: true });
    fs.writeFileSync(code, "// body");
    fs.utimesSync(code, new Date("2026-09-20T11:00:00Z"), new Date("2026-09-20T11:00:00Z"));
    expect(await compositionChangedAtMs(pieceId)).toBe(Date.parse("2026-09-20T11:00:00Z"));
  });
});
