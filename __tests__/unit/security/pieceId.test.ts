import { describe, it, expect } from "vitest";
import { isSafePieceId, assertSafePieceId } from "@/lib/security/pieceId";

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
