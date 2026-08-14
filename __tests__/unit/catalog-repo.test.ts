import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb } from "../helpers/test-db";
import { CatalogRepo } from "@/lib/catalog/repo";
import { pieces, files } from "@/lib/db/schema";

let db: ReturnType<typeof createTestDb>;
let repo: CatalogRepo;

beforeEach(() => {
  db = createTestDb();
  db.insert(pieces).values({ id: "p1", name: "P1", description: "" }).run();
  db.insert(files).values({
    id: "f1",
    pieceId: "p1",
    filename: "a.jpg",
    name: "a.jpg",
    description: "",
    type: "image",
    storagePath: "p1/a.jpg",
    contentType: "image/jpeg",
    size: 1,
  }).run();
  repo = new CatalogRepo(db);
});

describe("CatalogRepo characters", () => {
  it("creates and lists", () => {
    const c = repo.createCharacter({ name: "Jessica", description: "Tennis player" });
    expect(c.id).toBeTruthy();
    expect(repo.listCharacters()).toHaveLength(1);
  });

  it("filters list by case-insensitive substring", () => {
    repo.createCharacter({ name: "Jessica Wong", description: "" });
    repo.createCharacter({ name: "Jessica K", description: "" });
    repo.createCharacter({ name: "Marcus", description: "" });
    expect(repo.listCharacters({ query: "jess" })).toHaveLength(2);
    expect(repo.listCharacters({ query: "Marc" })).toHaveLength(1);
  });

  it("rejects duplicate name (case-sensitive — DB constraint)", () => {
    repo.createCharacter({ name: "Jessica", description: "" });
    expect(() => repo.createCharacter({ name: "Jessica", description: "" })).toThrow();
  });

  it("links and unlinks an asset", () => {
    const c = repo.createCharacter({ name: "Jessica", description: "" });
    repo.linkCharacterToAsset(c.id, "f1");
    expect(repo.getCharacterAssets(c.id)).toHaveLength(1);
    repo.unlinkCharacterFromAsset(c.id, "f1");
    expect(repo.getCharacterAssets(c.id)).toHaveLength(0);
  });

  it("link is idempotent (re-linking same pair does not throw)", () => {
    const c = repo.createCharacter({ name: "Jessica", description: "" });
    repo.linkCharacterToAsset(c.id, "f1");
    expect(() => repo.linkCharacterToAsset(c.id, "f1")).not.toThrow();
    expect(repo.getCharacterAssets(c.id)).toHaveLength(1);
  });

  it("delete removes character and cascades mappings, leaves files", () => {
    const c = repo.createCharacter({ name: "Jessica", description: "" });
    repo.linkCharacterToAsset(c.id, "f1");
    repo.deleteCharacter(c.id);
    expect(repo.listCharacters()).toHaveLength(0);
    expect(db.select().from(files).all()).toHaveLength(1);
  });
});

describe("CatalogRepo items mirror characters", () => {
  it("supports same-name across types", () => {
    repo.createCharacter({ name: "Jessica", description: "" });
    expect(() => repo.createItem({ name: "Jessica", description: "" })).not.toThrow();
  });
});
