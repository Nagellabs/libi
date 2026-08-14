import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { GET as charGET } from "@/app/api/pieces/[pieceId]/characters/route";
import { GET as itemGET } from "@/app/api/pieces/[pieceId]/items/route";
import { pieces, files } from "@/lib/db/schema";
import { CatalogRepo } from "@/lib/catalog/repo";
import { getDb } from "@/lib/db/client";

beforeEach(() => {
  const db = createTestDb();
  db.insert(pieces).values([
    { id: "p1", name: "P1", description: "" },
    { id: "p2", name: "P2", description: "" },
  ]).run();
  db.insert(files).values([
    { id: "f1", pieceId: "p1", filename: "a.jpg", name: "a.jpg", description: "", type: "image", storagePath: "p1/a.jpg", contentType: "image/jpeg", size: 1 },
    { id: "f2", pieceId: "p1", filename: "b.mp4", name: "b.mp4", description: "", type: "video", storagePath: "p1/b.mp4", contentType: "video/mp4", size: 1 },
    { id: "f3", pieceId: "p2", filename: "c.jpg", name: "c.jpg", description: "", type: "image", storagePath: "p2/c.jpg", contentType: "image/jpeg", size: 1 },
  ]).run();
});

afterEach(() => resetTestDb());

describe("piece catalog API", () => {
  it("characters: returns groups derived from piece assets", async () => {
    const repo = new CatalogRepo(getDb() as never);
    const c = repo.createCharacter({ name: "Jessica", description: "" });
    repo.linkCharacterToAsset(c.id, "f1");

    const r = await charGET(new Request("http://x"), { params: Promise.resolve({ pieceId: "p1" }) });
    const body = await r.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].file.id).toBe("f1");
    expect(body.groups[0].characters[0].name).toBe("Jessica");
    expect(body.groups[0].characters[0].representativeImageUrl).toBeNull();
  });

  it("characters: excludes mappings from other pieces", async () => {
    const repo = new CatalogRepo(getDb() as never);
    const c = repo.createCharacter({ name: "Jessica", description: "" });
    repo.linkCharacterToAsset(c.id, "f3"); // belongs to p2
    const r = await charGET(new Request("http://x"), { params: Promise.resolve({ pieceId: "p1" }) });
    const body = await r.json();
    expect(body.groups).toEqual([]);
  });

  it("items: parallel behavior", async () => {
    const repo = new CatalogRepo(getDb() as never);
    const i = repo.createItem({ name: "Tennis Racket", description: "" });
    repo.linkItemToAsset(i.id, "f2");
    const r = await itemGET(new Request("http://x"), { params: Promise.resolve({ pieceId: "p1" }) });
    const body = await r.json();
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].file.id).toBe("f2");
    expect(body.groups[0].items[0].name).toBe("Tennis Racket");
  });

  it("returns empty groups for piece with no linked catalog entries", async () => {
    const r = await charGET(new Request("http://x"), { params: Promise.resolve({ pieceId: "p1" }) });
    const body = await r.json();
    expect(body.groups).toEqual([]);
  });
});
