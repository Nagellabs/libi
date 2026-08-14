import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { characters, items, characterAssets, itemAssets, files, pieces } from "@/lib/db/schema";
import { eq } from "drizzle-orm";

describe("catalog schema", () => {
  it("characters table enforces UNIQUE(name) but allows same name in items", () => {
    const db = createTestDb();
    db.insert(characters).values({ id: "c1", name: "Jessica", description: "Tennis player" }).run();
    db.insert(items).values({ id: "i1", name: "Jessica", description: "A drink brand" }).run();
    expect(() =>
      db.insert(characters).values({ id: "c2", name: "Jessica", description: "Different person" }).run(),
    ).toThrow(/UNIQUE/i);
  });

  it("character_assets cascades on character delete", () => {
    const db = createTestDb();
    db.insert(pieces).values({ id: "p1", name: "P1", description: "" }).run();
    db.insert(files).values({ id: "f1", pieceId: "p1", filename: "a.jpg", name: "a.jpg", description: "", type: "image", storagePath: "p1/a.jpg", contentType: "image/jpeg", size: 1 }).run();
    db.insert(characters).values({ id: "c1", name: "X", description: "" }).run();
    db.insert(characterAssets).values({ characterId: "c1", fileId: "f1" }).run();
    db.delete(characters).where(eq(characters.id, "c1")).run();
    const rows = db.select().from(characterAssets).all();
    expect(rows).toHaveLength(0);
  });

  it("character_assets cascades on file delete but character survives", () => {
    const db = createTestDb();
    db.insert(pieces).values({ id: "p1", name: "P1", description: "" }).run();
    db.insert(files).values({ id: "f1", pieceId: "p1", filename: "a.jpg", name: "a.jpg", description: "", type: "image", storagePath: "p1/a.jpg", contentType: "image/jpeg", size: 1 }).run();
    db.insert(characters).values({ id: "c1", name: "X", description: "" }).run();
    db.insert(characterAssets).values({ characterId: "c1", fileId: "f1" }).run();
    db.delete(files).where(eq(files.id, "f1")).run();
    expect(db.select().from(characterAssets).all()).toHaveLength(0);
    expect(db.select().from(characters).all()).toHaveLength(1);
  });
});
