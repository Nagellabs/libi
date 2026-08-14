import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock crop helper so we don't actually invoke ffmpeg in tests.
// The mock inserts a real `files` row so FK constraints from
// `characters.representative_image_file_id` are satisfied.
vi.mock("@/lib/catalog/crop", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/catalog/crop")>(
      "@/lib/catalog/crop",
    );
  return {
    ...actual,
    cropAndStoreRepresentative: vi.fn(
      async ({ cropName }: { cropName: string }) => {
        const { getDb } = await import("@/lib/db/client");
        const { files } = await import("@/lib/db/schema");
        const id = `rep-${cropName}`;
        const record = {
          id,
          pieceId: null,
          filename: `${cropName}.jpg`,
          name: `${cropName}.jpg`,
          description: "",
          type: "image",
          storagePath: `_global/${cropName}.jpg`,
          contentType: "image/jpeg",
          size: 1,
          mediaDuration: null,
          mediaWidth: null,
          mediaHeight: null,
          hasAudio: null,
          proxyFilename: null,
          proxyStatus: "idle" as const,
          proxyGeneratedAt: null,
          createdAt: new Date(),
        };
        getDb().insert(files).values(record).run();
        return record;
      },
    ),
  };
});

import { createTestDb, resetTestDb } from "../helpers/test-db";
import { pieces, files } from "@/lib/db/schema";
import {
  listCharacters,
  createCharacter,
  deleteCharacter,
} from "@/mcp/tools/character-tools";

beforeEach(() => {
  const db = createTestDb();
  db.insert(pieces).values({ id: "p1", name: "P1", description: "" }).run();
  db.insert(files)
    .values({
      id: "f1",
      pieceId: "p1",
      filename: "src.mp4",
      name: "src.mp4",
      description: "",
      type: "video",
      storagePath: "p1/src.mp4",
      contentType: "video/mp4",
      size: 1000,
      mediaWidth: 1920,
      mediaHeight: 1080,
      mediaDuration: 60,
    })
    .run();
});

afterEach(() => resetTestDb());

describe("character tools", () => {
  it("list returns empty initially", async () => {
    const r = await listCharacters({} as never, {});
    expect(JSON.parse(r.content[0].text).characters).toEqual([]);
  });

  it("create with fromAsset crops and stores rep image and auto-links source", async () => {
    const r = await createCharacter({} as never, {
      name: "Jessica",
      description: "Tennis lead",
      fromAsset: {
        fileId: "f1",
        bbox: { x: 100, y: 100, w: 400, h: 600 },
        frameTime: 12.5,
      },
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.character.name).toBe("Jessica");
    expect(body.character.representativeImageFileId).toBe("rep-Jessica");
    expect(body.character.linkedAssetIds).toContain("f1");
    expect(body.character.representativeImageUrl).toBe(
      "/api/files/by-id/rep-Jessica/content",
    );
  });

  it("duplicate name rejected with friendly error", async () => {
    await createCharacter({} as never, { name: "Jessica" });
    const r = await createCharacter({} as never, { name: "Jessica" });
    expect(r.error).toMatch(/already exists/i);
  });

  it("delete removes character", async () => {
    const created = JSON.parse(
      (await createCharacter({} as never, { name: "Jessica" })).content[0].text,
    );
    await deleteCharacter({} as never, { id: created.character.id });
    const list = JSON.parse(
      (await listCharacters({} as never, {})).content[0].text,
    );
    expect(list.characters).toEqual([]);
  });

  it("create video source REQUIRES frameTime", async () => {
    const r = await createCharacter({} as never, {
      name: "Marcus",
      fromAsset: { fileId: "f1", bbox: { x: 10, y: 10, w: 100, h: 100 } },
    });
    expect(r.error).toMatch(/frametime/i);
  });
});
