import { describe, it, expect } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { pieces, files } from "@/lib/db/schema";
import { CatalogRepo } from "@/lib/catalog/repo";
import { CatalogDerive } from "@/lib/catalog/derive";

describe("CatalogDerive", () => {
  it("returns characters grouped by asset for a piece", () => {
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

    const repo = new CatalogRepo(db);
    const c1 = repo.createCharacter({ name: "Jessica", description: "" });
    const c2 = repo.createCharacter({ name: "Marcus", description: "" });
    repo.linkCharacterToAsset(c1.id, "f1");
    repo.linkCharacterToAsset(c1.id, "f2");
    repo.linkCharacterToAsset(c2.id, "f1");
    repo.linkCharacterToAsset(c1.id, "f3"); // different piece — must NOT appear in p1 results

    const derive = new CatalogDerive(db);
    const grouped = derive.charactersByAssetForPiece("p1");

    expect(grouped).toHaveLength(2);
    const f1Group = grouped.find((g) => g.file.id === "f1")!;
    expect(f1Group.characters.map((c) => c.name).sort()).toEqual(["Jessica", "Marcus"]);
    const f2Group = grouped.find((g) => g.file.id === "f2")!;
    expect(f2Group.characters.map((c) => c.name)).toEqual(["Jessica"]);
  });

  it("returns empty array when piece has no files", () => {
    const db = createTestDb();
    db.insert(pieces).values({ id: "p1", name: "P1", description: "" }).run();
    expect(new CatalogDerive(db).charactersByAssetForPiece("p1")).toEqual([]);
    expect(new CatalogDerive(db).itemsByAssetForPiece("p1")).toEqual([]);
  });

  it("itemsByAssetForPiece works in parallel to charactersByAssetForPiece", () => {
    const db = createTestDb();
    db.insert(pieces).values({ id: "p1", name: "P1", description: "" }).run();
    db.insert(files).values({ id: "f1", pieceId: "p1", filename: "a.jpg", name: "a.jpg", description: "", type: "image", storagePath: "p1/a.jpg", contentType: "image/jpeg", size: 1 }).run();
    const repo = new CatalogRepo(db);
    const i1 = repo.createItem({ name: "Tennis Racket", description: "" });
    repo.linkItemToAsset(i1.id, "f1");
    const grouped = new CatalogDerive(db).itemsByAssetForPiece("p1");
    expect(grouped).toHaveLength(1);
    expect(grouped[0].items.map((i) => i.name)).toEqual(["Tennis Racket"]);
  });
});
