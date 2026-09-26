import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { pieces, templates, templateUses } from "@/lib/db/schema/sqlite";

describe("templates tables", () => {
  let db: ReturnType<typeof createTestDb>;
  beforeEach(() => {
    db = createTestDb();
  });
  afterEach(() => resetTestDb());

  it("the bundled sqlite has FTS5 compiled in (every later task assumes it)", () => {
    const raw = new Database(":memory:");
    const row = raw.prepare("SELECT sqlite_compileoption_used('ENABLE_FTS5') AS f").get() as { f: number };
    raw.close();
    expect(row.f).toBe(1);
  });

  it("inserts a template with defaults and reads it back", () => {
    const [row] = db
      .insert(templates)
      .values({ name: "Lower third", description: "A name card", tags: '["promo"]' })
      .returning()
      .all();
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.origin).toBe("local");
    expect(row.cloudId).toBeNull();
    expect(row.version).toBe(1);
    expect(row.hasCode).toBe(false);
    expect(row.useCount).toBe(0);
    expect(row.lastUsedAt).toBeNull();
  });

  it("template_uses cascades on template delete and nulls on piece delete", () => {
    const pieceId = seedPiece(db, { id: "p1" });
    const [t] = db.insert(templates).values({ name: "T", description: "", tags: "[]" }).returning().all();
    db.insert(templateUses).values({ templateId: t.id, pieceId }).run();
    db.delete(pieces).where(eq(pieces.id, pieceId)).run();
    expect(db.select().from(templateUses).all()[0].pieceId).toBeNull();
    db.delete(templates).where(eq(templates.id, t.id)).run();
    expect(db.select().from(templateUses).all()).toHaveLength(0);
  });

  it("createdFromPieceId is set null when the source piece is deleted", () => {
    const pieceId = seedPiece(db, { id: "p2" });
    const [t] = db.insert(templates).values({ name: "T", description: "", tags: "[]", createdFromPieceId: pieceId }).returning().all();
    db.delete(pieces).where(eq(pieces.id, pieceId)).run();
    expect(db.select().from(templates).where(eq(templates.id, t.id)).get()!.createdFromPieceId).toBeNull();
  });

  it("templates_fts follows inserts, updates and deletes through its triggers", () => {
    const [t] = db.insert(templates).values({ name: "Lower third", description: "A name card", tags: '["promo","name-card"]' }).returning().all();
    const hit = () => db.all<{ ref_id: string }>(sql`SELECT ref_id FROM templates_fts WHERE templates_fts MATCH ${'"promo"*'} AND scope = 'local'`);
    expect(hit().map((r) => r.ref_id)).toEqual([t.id]);
    db.update(templates).set({ tags: '["other"]' }).where(eq(templates.id, t.id)).run();
    expect(hit()).toHaveLength(0);
    expect(db.all<{ ref_id: string }>(sql`SELECT ref_id FROM templates_fts WHERE templates_fts MATCH ${'"other"*'}`)).toHaveLength(1);
    db.delete(templates).where(eq(templates.id, t.id)).run();
    expect(db.all(sql`SELECT ref_id FROM templates_fts`)).toHaveLength(0);
  });
});
