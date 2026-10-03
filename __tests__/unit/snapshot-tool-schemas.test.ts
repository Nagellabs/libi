import { describe, it, expect } from "vitest";
import {
  getPieceStateSchema,
  commitDraftSchema,
  discardDraftSchema,
  restoreSnapshotSchema,
  compareStatesSchema,
} from "@/mcp/tools/schemas";

describe("snapshot tool schemas", () => {
  it("getPieceStateSchema takes one pieceId or a pieceIds sweep (the tool checks one was given)", () => {
    expect(getPieceStateSchema.parse({ pieceId: "p1" }).pieceId).toBe("p1");
    expect(getPieceStateSchema.parse({ pieceIds: ["p1", "p2"] }).pieceIds).toEqual(["p1", "p2"]);
    expect(() => getPieceStateSchema.parse({ pieceIds: [] })).toThrow();
  });

  it("commitDraftSchema accepts optional summary", () => {
    expect(commitDraftSchema.parse({ pieceId: "p1" }).summary).toBeUndefined();
    expect(commitDraftSchema.parse({ pieceId: "p1", summary: "hi" }).summary).toBe("hi");
  });

  it("discardDraftSchema requires confirm: true", () => {
    expect(() => discardDraftSchema.parse({ pieceId: "p1" })).toThrow();
    expect(() => discardDraftSchema.parse({ pieceId: "p1", confirm: false })).toThrow();
    expect(discardDraftSchema.parse({ pieceId: "p1", confirm: true }).confirm).toBe(true);
  });

  it("restoreSnapshotSchema requires snapshotId + confirm", () => {
    expect(() => restoreSnapshotSchema.parse({ pieceId: "p1", snapshotId: "s1" })).toThrow();
    expect(restoreSnapshotSchema.parse({ pieceId: "p1", snapshotId: "s1", confirm: true }).snapshotId).toBe("s1");
  });

  it("compareStatesSchema requires pieceId", () => {
    expect(() => compareStatesSchema.parse({})).toThrow();
    expect(compareStatesSchema.parse({ pieceId: "p1" }).pieceId).toBe("p1");
  });
});
