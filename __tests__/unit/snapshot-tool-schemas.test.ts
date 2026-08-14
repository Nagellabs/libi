import { describe, it, expect } from "vitest";
import {
  getPieceStateSchema,
  commitDraftSchema,
  discardDraftSchema,
  restoreSnapshotSchema,
  compareStatesSchema,
} from "@/mcp/tools/schemas";

describe("snapshot tool schemas", () => {
  it("getPieceStateSchema requires pieceId", () => {
    expect(() => getPieceStateSchema.parse({})).toThrow();
    expect(getPieceStateSchema.parse({ pieceId: "p1" }).pieceId).toBe("p1");
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
