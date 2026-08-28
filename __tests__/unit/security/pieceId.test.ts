import { describe, it, expect } from "vitest";
import {
  isSafePieceId,
  assertSafePieceId,
  isSafeTrackId,
  assertSafeTrackId,
} from "@/lib/security/pieceId";

describe("isSafePieceId", () => {
  it("accepts null (global scope)", () => {
    expect(isSafePieceId(null)).toBe(true);
  });

  it("accepts real UUID-shaped piece ids (crypto.randomUUID)", () => {
    expect(isSafePieceId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
    expect(isSafePieceId(crypto.randomUUID())).toBe(true);
  });

  it("accepts ids with letters, digits, hyphens and underscores", () => {
    expect(isSafePieceId("ok_id-123")).toBe(true);
    expect(isSafePieceId("ABC")).toBe(true);
    expect(isSafePieceId("_global")).toBe(true);
  });

  it("rejects traversal / separator / empty ids", () => {
    expect(isSafePieceId("../agent")).toBe(false);
    expect(isSafePieceId("../../")).toBe(false);
    expect(isSafePieceId("a/b")).toBe(false);
    expect(isSafePieceId("a\\b")).toBe(false);
    expect(isSafePieceId(".")).toBe(false);
    expect(isSafePieceId("..")).toBe(false);
    expect(isSafePieceId("")).toBe(false);
    expect(isSafePieceId("a.b")).toBe(false);
    expect(isSafePieceId("with space")).toBe(false);
    expect(isSafePieceId("nul\0byte")).toBe(false);
  });
});

describe("assertSafePieceId", () => {
  it("does not throw for null or valid ids", () => {
    expect(() => assertSafePieceId(null)).not.toThrow();
    expect(() => assertSafePieceId("ok_id-123")).not.toThrow();
    expect(() => assertSafePieceId(crypto.randomUUID())).not.toThrow();
  });

  it("throws 'unsafe_piece_id' for traversal ids", () => {
    expect(() => assertSafePieceId("../agent")).toThrow("unsafe_piece_id");
    expect(() => assertSafePieceId("../../")).toThrow("unsafe_piece_id");
    expect(() => assertSafePieceId("a/b")).toThrow("unsafe_piece_id");
    expect(() => assertSafePieceId("")).toThrow("unsafe_piece_id");
  });
});

describe("isSafeTrackId", () => {
  it("accepts real track ids (trk-<uuid-segment>)", () => {
    expect(isSafeTrackId("trk-1")).toBe(true);
    expect(isSafeTrackId("trk-abc123")).toBe(true);
    expect(isSafeTrackId(`trk-${crypto.randomUUID().split("-")[0]}`)).toBe(true);
    expect(isSafeTrackId("t-cascade")).toBe(true);
  });

  it("rejects traversal / separator / empty track ids", () => {
    expect(isSafeTrackId("../../evil")).toBe(false);
    expect(isSafeTrackId("a/b")).toBe(false);
    expect(isSafeTrackId("a\\b")).toBe(false);
    expect(isSafeTrackId("..")).toBe(false);
    expect(isSafeTrackId("a.json")).toBe(false);
    expect(isSafeTrackId("")).toBe(false);
    expect(isSafeTrackId("nul\0byte")).toBe(false);
  });
});

describe("assertSafeTrackId", () => {
  it("does not throw for valid track ids", () => {
    expect(() => assertSafeTrackId("trk-abc123")).not.toThrow();
  });

  it("throws 'unsafe_track_id' for traversal ids", () => {
    expect(() => assertSafeTrackId("../../evil")).toThrow("unsafe_track_id");
    expect(() => assertSafeTrackId("a/b")).toThrow("unsafe_track_id");
    expect(() => assertSafeTrackId("")).toThrow("unsafe_track_id");
  });
});
