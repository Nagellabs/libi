import { describe, it, expect } from "vitest";
import {
  getCompositionSchema,
  updatePieceSchema,
  saveAssetSchema,
} from "@/mcp/tools/schemas";

describe("getCompositionSchema", () => {
  it("accepts valid pieceId", () => {
    const result = getCompositionSchema.safeParse({ pieceId: "piece-1" });
    expect(result.success).toBe(true);
  });

  it("takes the multi-piece and view forms; which one is given is checked by the tool (it says what to send)", () => {
    expect(getCompositionSchema.safeParse({ pieceIds: ["a", "b"], view: "timeline" }).success).toBe(true);
    expect(getCompositionSchema.safeParse({ folderId: "f", view: "timeline" }).success).toBe(true);
    expect(getCompositionSchema.safeParse({ pieceId: "a", view: "full" }).success).toBe(true);
    expect(getCompositionSchema.safeParse({ pieceId: "a", view: "wide" }).success).toBe(false);
    expect(getCompositionSchema.safeParse({ pieceIds: [] }).success).toBe(false);
    expect(getCompositionSchema.safeParse({ pieceIds: Array.from({ length: 25 }, (_, i) => `p${i}`) }).success).toBe(false);
  });
});

describe("updatePieceSchema", () => {
  it("accepts name only", () => {
    expect(updatePieceSchema.safeParse({ pieceId: "piece-1", name: "Cool Video" }).success).toBe(true);
  });

  it("accepts description only", () => {
    expect(updatePieceSchema.safeParse({ pieceId: "piece-1", description: "A brief overview" }).success).toBe(true);
  });

  it("accepts name and description", () => {
    const result = updatePieceSchema.safeParse({
      pieceId: "piece-1",
      name: "Cool Video",
      description: "A cool description",
    });
    expect(result.success).toBe(true);
  });

  it("leaves 'at least one of name, description' to the handler, so the advertised schema stays a plain object", () => {
    expect(updatePieceSchema.safeParse({ pieceId: "piece-1" }).success).toBe(true);
  });

  it("rejects missing pieceId", () => {
    expect(updatePieceSchema.safeParse({ name: "No Piece" }).success).toBe(false);
    expect(updatePieceSchema.safeParse({ description: "No piece" }).success).toBe(false);
  });

  it("rejects name exceeding 100 characters, accepts exactly 100", () => {
    expect(updatePieceSchema.safeParse({ pieceId: "piece-1", name: "x".repeat(101) }).success).toBe(false);
    expect(updatePieceSchema.safeParse({ pieceId: "piece-1", name: "x".repeat(100) }).success).toBe(true);
  });

  it("rejects description exceeding 500 characters", () => {
    expect(updatePieceSchema.safeParse({ pieceId: "piece-1", name: "Valid", description: "x".repeat(501) }).success).toBe(false);
    expect(updatePieceSchema.safeParse({ pieceId: "piece-1", description: "y".repeat(501) }).success).toBe(false);
  });
});

describe("saveAssetSchema", () => {
  it("accepts valid input with all fields", () => {
    const result = saveAssetSchema.safeParse({
      pieceId: "piece-1",
      filename: "voice.mp3",
      name: "Voiceover",
      description: "Narration for scene 1",
      type: "audio/voiceover",
      contentType: "audio/mpeg",
      data: Buffer.from("audio").toString("base64"),
    });
    expect(result.success).toBe(true);
  });

  it("accepts input without optional contentType", () => {
    const result = saveAssetSchema.safeParse({
      pieceId: "piece-1",
      filename: "sfx.wav",
      name: "SFX",
      description: "Bang sound",
      type: "audio/sfx",
      data: Buffer.from("wav").toString("base64"),
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing filename", () => {
    const result = saveAssetSchema.safeParse({
      pieceId: "piece-1",
      name: "No Filename",
      description: "Missing filename field",
      type: "audio/sfx",
      data: Buffer.from("data").toString("base64"),
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing data", () => {
    const result = saveAssetSchema.safeParse({
      pieceId: "piece-1",
      filename: "file.mp3",
      name: "Missing Data",
      description: "No data field",
      type: "audio/sfx",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing name", () => {
    const result = saveAssetSchema.safeParse({
      pieceId: "piece-1",
      filename: "file.mp3",
      description: "No name field",
      type: "audio/sfx",
      data: Buffer.from("data").toString("base64"),
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing pieceId", () => {
    const result = saveAssetSchema.safeParse({
      filename: "file.mp3",
      name: "No Piece",
      description: "Missing pieceId",
      type: "audio/sfx",
      data: Buffer.from("data").toString("base64"),
    });
    expect(result.success).toBe(false);
  });
});
