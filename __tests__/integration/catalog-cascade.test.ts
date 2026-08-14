import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock crop so we don't need real ffmpeg / files. The mock must INSERT a real
// `files` row because `characters.representative_image_file_id` has a real FK.
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
        const id = `rep-${cropName}-${Math.random().toString(36).slice(2, 8)}`;
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

import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { pieces, files, characterAssets } from "@/lib/db/schema";
import { CatalogRepo } from "@/lib/catalog/repo";
import {
  createCharacter,
  deleteCharacter,
  listCharacters,
} from "@/mcp/tools/character-tools";
import { getDb } from "@/lib/db/client";

beforeEach(() => {
  const db = createTestDb();
  db.insert(pieces).values({ id: "p1", name: "P1", description: "" }).run();
  db.insert(files)
    .values([
      {
        id: "f1",
        pieceId: "p1",
        filename: "v.mp4",
        name: "v.mp4",
        description: "",
        type: "video",
        storagePath: "p1/v.mp4",
        contentType: "video/mp4",
        size: 1,
        mediaWidth: 1920,
        mediaHeight: 1080,
        mediaDuration: 60,
      },
      {
        id: "f2",
        pieceId: "p1",
        filename: "i.jpg",
        name: "i.jpg",
        description: "",
        type: "image",
        storagePath: "p1/i.jpg",
        contentType: "image/jpeg",
        size: 1,
        mediaWidth: 800,
        mediaHeight: 600,
      },
    ])
    .run();
});

afterEach(() => resetTestDb());

describe("catalog cascade", () => {
  it("delete character WITH deleteAssets:true removes all linked files", async () => {
    const created = JSON.parse(
      (
        await createCharacter({} as never, {
          name: "Jessica",
          fromAsset: {
            fileId: "f1",
            bbox: { x: 100, y: 100, w: 200, h: 200 },
            frameTime: 5,
          },
        })
      ).content[0].text,
    );

    // f1 was auto-linked, plus we manually link f2
    const repo = new CatalogRepo(getDb() as never);
    repo.linkCharacterToAsset(created.character.id, "f2");

    expect(
      repo.getCharacterAssets(created.character.id).length,
    ).toBeGreaterThanOrEqual(2);

    const r = await deleteCharacter({} as never, {
      id: created.character.id,
      deleteAssets: true,
    });
    const body = JSON.parse(r.content[0].text);
    expect(body.deletedAssetCount).toBeGreaterThanOrEqual(2);

    const remaining = JSON.parse(
      (await listCharacters({} as never, {})).content[0].text,
    );
    expect(remaining.characters).toHaveLength(0);

    // Linked files should be gone (f1 + f2)
    expect(
      getDb().select().from(files).where(eq(files.id, "f1")).get(),
    ).toBeUndefined();
    expect(
      getDb().select().from(files).where(eq(files.id, "f2")).get(),
    ).toBeUndefined();
  });

  it("delete character WITHOUT deleteAssets leaves source files intact", async () => {
    const created = JSON.parse(
      (
        await createCharacter({} as never, {
          name: "Jessica",
          fromAsset: {
            fileId: "f1",
            bbox: { x: 100, y: 100, w: 200, h: 200 },
            frameTime: 5,
          },
        })
      ).content[0].text,
    );

    await deleteCharacter({} as never, { id: created.character.id });

    expect(
      getDb().select().from(files).where(eq(files.id, "f1")).get(),
    ).toBeTruthy();
    expect(getDb().select().from(characterAssets).all()).toHaveLength(0);
  });

  it("deleting an underlying file cascades to remove the mapping but character survives", async () => {
    const created = JSON.parse(
      (await createCharacter({} as never, { name: "Jessica" })).content[0].text,
    );
    const repo = new CatalogRepo(getDb() as never);
    repo.linkCharacterToAsset(created.character.id, "f1");

    expect(repo.getCharacterAssets(created.character.id)).toHaveLength(1);

    getDb().delete(files).where(eq(files.id, "f1")).run();

    expect(repo.getCharacterAssets(created.character.id)).toHaveLength(0);
    expect(repo.getCharacter(created.character.id)).toBeTruthy();
  });

  it("deleting a piece cascades through files to remove character_assets mappings", async () => {
    const created = JSON.parse(
      (await createCharacter({} as never, { name: "Jessica" })).content[0].text,
    );
    const repo = new CatalogRepo(getDb() as never);
    repo.linkCharacterToAsset(created.character.id, "f1");

    getDb().delete(pieces).where(eq(pieces.id, "p1")).run();

    // Files in p1 are gone, mappings cascade. Character itself remains.
    expect(
      getDb().select().from(files).where(eq(files.pieceId, "p1")).all(),
    ).toHaveLength(0);
    expect(repo.getCharacterAssets(created.character.id)).toHaveLength(0);
    expect(repo.getCharacter(created.character.id)).toBeTruthy();
  });
});
