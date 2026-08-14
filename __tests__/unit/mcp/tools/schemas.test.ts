import { describe, it, expect } from "vitest";
import {
  createSceneSchema,
  updateSceneSchema,
  deleteSceneSchema,
  reorderScenesSchema,
  getCompositionSchema,
  loadSceneSchema,
  updatePieceNameSchema,
  updatePieceDescriptionSchema,
  saveAssetSchema,
} from "@/mcp/tools/schemas";

describe("createSceneSchema", () => {
  it("accepts valid input", () => {
    const result = createSceneSchema.safeParse({
      pieceId: "piece-1",
      name: "Opening Scene",
      duration: 5,
      drawFunction: "ctx.fillRect(0, 0, 100, 100);",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing pieceId", () => {
    const result = createSceneSchema.safeParse({
      name: "Opening Scene",
      duration: 5,
      drawFunction: "ctx.fillRect(0, 0, 100, 100);",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing name", () => {
    const result = createSceneSchema.safeParse({
      pieceId: "piece-1",
      duration: 5,
      drawFunction: "ctx.fillRect(0, 0, 100, 100);",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive duration (zero)", () => {
    const result = createSceneSchema.safeParse({
      pieceId: "piece-1",
      name: "Bad Scene",
      duration: 0,
      drawFunction: "ctx.fillRect(0, 0, 100, 100);",
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-positive duration (negative)", () => {
    const result = createSceneSchema.safeParse({
      pieceId: "piece-1",
      name: "Negative Scene",
      duration: -3,
      drawFunction: "ctx.fillRect(0, 0, 100, 100);",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing drawFunction", () => {
    const result = createSceneSchema.safeParse({
      pieceId: "piece-1",
      name: "No Draw",
      duration: 2,
    });
    expect(result.success).toBe(false);
  });
});

describe("updateSceneSchema", () => {
  it("accepts valid input with all fields", () => {
    const result = updateSceneSchema.safeParse({
      pieceId: "piece-1",
      sceneId: "scene-abc",
      name: "Updated Name",
      duration: 4,
      drawFunction: "// new code",
    });
    expect(result.success).toBe(true);
  });

  it("accepts partial update (only sceneId)", () => {
    const result = updateSceneSchema.safeParse({
      pieceId: "piece-1",
      sceneId: "scene-abc",
    });
    expect(result.success).toBe(true);
  });

  it("accepts partial update (sceneId + name only)", () => {
    const result = updateSceneSchema.safeParse({
      pieceId: "piece-1",
      sceneId: "scene-abc",
      name: "Just Rename",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing sceneId", () => {
    const result = updateSceneSchema.safeParse({
      pieceId: "piece-1",
      name: "No ID",
      duration: 3,
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing pieceId", () => {
    const result = updateSceneSchema.safeParse({
      sceneId: "scene-abc",
      name: "No Piece",
    });
    expect(result.success).toBe(false);
  });
});

describe("deleteSceneSchema", () => {
  it("accepts valid input", () => {
    const result = deleteSceneSchema.safeParse({
      pieceId: "piece-1",
      sceneId: "scene-xyz",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing sceneId", () => {
    const result = deleteSceneSchema.safeParse({ pieceId: "piece-1" });
    expect(result.success).toBe(false);
  });

  it("rejects missing pieceId", () => {
    const result = deleteSceneSchema.safeParse({ sceneId: "scene-xyz" });
    expect(result.success).toBe(false);
  });
});

describe("reorderScenesSchema", () => {
  it("accepts valid array of scene IDs", () => {
    const result = reorderScenesSchema.safeParse({
      pieceId: "piece-1",
      sceneIds: ["scene-b", "scene-a", "scene-c"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty array", () => {
    const result = reorderScenesSchema.safeParse({
      pieceId: "piece-1",
      sceneIds: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects when sceneIds is not an array (string)", () => {
    const result = reorderScenesSchema.safeParse({
      pieceId: "piece-1",
      sceneIds: "scene-a,scene-b",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing sceneIds", () => {
    const result = reorderScenesSchema.safeParse({ pieceId: "piece-1" });
    expect(result.success).toBe(false);
  });

  it("rejects missing pieceId", () => {
    const result = reorderScenesSchema.safeParse({
      sceneIds: ["scene-a"],
    });
    expect(result.success).toBe(false);
  });
});

describe("getCompositionSchema", () => {
  it("accepts valid pieceId", () => {
    const result = getCompositionSchema.safeParse({ pieceId: "piece-1" });
    expect(result.success).toBe(true);
  });

  it("rejects missing pieceId", () => {
    const result = getCompositionSchema.safeParse({});
    expect(result.success).toBe(false);
  });
});

describe("loadSceneSchema", () => {
  it("accepts valid input", () => {
    const result = loadSceneSchema.safeParse({
      pieceId: "piece-1",
      sceneId: "scene-abc",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing pieceId", () => {
    const result = loadSceneSchema.safeParse({ sceneId: "scene-abc" });
    expect(result.success).toBe(false);
  });

  it("rejects missing sceneId", () => {
    const result = loadSceneSchema.safeParse({ pieceId: "piece-1" });
    expect(result.success).toBe(false);
  });
});

describe("updatePieceNameSchema", () => {
  it("accepts name only", () => {
    const result = updatePieceNameSchema.safeParse({
      pieceId: "piece-1",
      name: "Cool Video",
    });
    expect(result.success).toBe(true);
  });

  it("accepts name and description", () => {
    const result = updatePieceNameSchema.safeParse({
      pieceId: "piece-1",
      name: "Cool Video",
      description: "A cool description",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing name", () => {
    const result = updatePieceNameSchema.safeParse({
      pieceId: "piece-1",
      description: "Only desc",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing pieceId", () => {
    const result = updatePieceNameSchema.safeParse({ name: "No Piece" });
    expect(result.success).toBe(false);
  });

  it("rejects name exceeding 100 characters", () => {
    const result = updatePieceNameSchema.safeParse({
      pieceId: "piece-1",
      name: "x".repeat(101),
    });
    expect(result.success).toBe(false);
  });

  it("accepts name exactly 100 characters", () => {
    const result = updatePieceNameSchema.safeParse({
      pieceId: "piece-1",
      name: "x".repeat(100),
    });
    expect(result.success).toBe(true);
  });

  it("rejects description exceeding 500 characters", () => {
    const result = updatePieceNameSchema.safeParse({
      pieceId: "piece-1",
      name: "Valid",
      description: "x".repeat(501),
    });
    expect(result.success).toBe(false);
  });
});

describe("updatePieceDescriptionSchema", () => {
  it("accepts a valid description", () => {
    const result = updatePieceDescriptionSchema.safeParse({
      pieceId: "piece-1",
      description: "A brief overview",
    });
    expect(result.success).toBe(true);
  });

  it("rejects missing description", () => {
    const result = updatePieceDescriptionSchema.safeParse({
      pieceId: "piece-1",
    });
    expect(result.success).toBe(false);
  });

  it("rejects missing pieceId", () => {
    const result = updatePieceDescriptionSchema.safeParse({
      description: "No piece",
    });
    expect(result.success).toBe(false);
  });

  it("rejects description exceeding 500 characters", () => {
    const result = updatePieceDescriptionSchema.safeParse({
      pieceId: "piece-1",
      description: "y".repeat(501),
    });
    expect(result.success).toBe(false);
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
