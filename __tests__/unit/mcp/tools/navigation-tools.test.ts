/**
 * The navigation tools must not report a navigation they did not perform.
 *
 * Until 2026-08-21 all four returned `{ navigated: true }` unconditionally,
 * without ever asking whether the target existed. The cost showed up in a real
 * onboarding run: with the demo piece deleted, the agent called
 * `libi.show_piece` on the dead id, got a success, and told the user "It's back
 * on screen — hit play" while the editor showed "No piece open". Nothing else
 * in the turn contradicted the success, so the agent had no way to notice.
 *
 * These tests exist so a target that is absent, or owned by someone else, can
 * never again come back as `navigated: true`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  showPiece,
  showAsset,
  showPreview,
  showStoryboard,
} from "@/mcp/tools/navigation-tools";
import { pieces, files } from "@/lib/db/schema/sqlite";
import { createTestDb, resetTestDb } from "../../../helpers/test-db";

const PIECE = "piece-1";
const OTHER = "piece-2";

beforeEach(async () => {
  await createTestDb();
  const db = (await import("@/lib/db/client")).getDb();
  db.insert(pieces).values({ id: PIECE, name: "P1", description: "" }).run();
  db.insert(pieces).values({ id: OTHER, name: "P2", description: "" }).run();
  db.insert(files)
    .values({
      id: "file-mine",
      pieceId: PIECE,
      filename: "a.mp4",
      name: "a.mp4",
      description: "",
      type: "video",
      storagePath: `${PIECE}/a.mp4`,
      contentType: "video/mp4",
      size: 10,
    })
    .run();
  db.insert(files)
    .values({
      id: "file-theirs",
      pieceId: OTHER,
      filename: "b.mp4",
      name: "b.mp4",
      description: "",
      type: "video",
      storagePath: `${OTHER}/b.mp4`,
      contentType: "video/mp4",
      size: 10,
    })
    .run();
  // pieceId NULL = a global file, legitimately showable from any piece.
  db.insert(files)
    .values({
      id: "file-global",
      pieceId: null,
      filename: "g.png",
      name: "g.png",
      description: "",
      type: "image",
      storagePath: "global/g.png",
      contentType: "image/png",
      size: 10,
    })
    .run();
});

afterEach(() => {
  resetTestDb();
});

describe.each([
  ["showPiece", showPiece],
  ["showPreview", showPreview],
  ["showStoryboard", showStoryboard],
] as const)("%s", (_name, fn) => {
  it("navigates for a piece that exists", async () => {
    expect(await fn({ pieceId: PIECE })).toEqual({
      success: true,
      data: { navigated: true, pieceId: PIECE },
    });
  });

  it("fails with piece_not_found for a piece that does not exist", async () => {
    const result = await fn({ pieceId: "deleted-id" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("piece_not_found");
    // The agent's recovery path: never a bare failure, always the tool to call.
    expect(result.data?.hint).toContain("libi.list_pieces");
  });

  it("never reports navigated on a failure", async () => {
    const result = await fn({ pieceId: "deleted-id" });
    expect(result.data?.navigated).toBeUndefined();
  });
});

describe("showAsset", () => {
  it("navigates for a file belonging to the piece", async () => {
    expect(await showAsset({ pieceId: PIECE, fileId: "file-mine" })).toEqual({
      success: true,
      data: { navigated: true, pieceId: PIECE, fileId: "file-mine" },
    });
  });

  it("navigates for a GLOBAL file (pieceId NULL) from any piece", async () => {
    const result = await showAsset({ pieceId: PIECE, fileId: "file-global" });
    expect(result.success).toBe(true);
    expect(result.data?.navigated).toBe(true);
  });

  it("fails with piece_not_found when the piece is gone", async () => {
    const result = await showAsset({ pieceId: "deleted-id", fileId: "file-mine" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("piece_not_found");
  });

  it("fails with file_not_found when the file is gone", async () => {
    const result = await showAsset({ pieceId: PIECE, fileId: "no-such-file" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("file_not_found");
    expect(result.data?.hint).toContain("libi.list_files");
  });

  it("fails with file_not_in_piece for a file owned by another piece, and names the owner", async () => {
    // The Assets tab would have nothing to select — the same silent lie as a
    // deleted file, so it must not come back as a success.
    const result = await showAsset({ pieceId: PIECE, fileId: "file-theirs" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("file_not_in_piece");
    expect(result.data?.ownerPieceId).toBe(OTHER);
  });

  it("never reports navigated on any failure", async () => {
    for (const params of [
      { pieceId: "deleted-id", fileId: "file-mine" },
      { pieceId: PIECE, fileId: "no-such-file" },
      { pieceId: PIECE, fileId: "file-theirs" },
    ]) {
      const result = await showAsset(params);
      expect(result.data?.navigated, JSON.stringify(params)).toBeUndefined();
    }
  });
});
