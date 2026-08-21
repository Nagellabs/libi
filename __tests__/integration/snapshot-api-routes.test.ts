/**
 * Integration tests for snapshot/draft REST API routes.
 * Covers: GET /state, POST /commit, POST /discard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { createTestDb, resetTestDb } from "../helpers/test-db";
import { pieces } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";

const PIECE_ID = "p_snap_api";
let storageRoot: string;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: BetterSQLite3Database<any>;

vi.mock("@/lib/storage", () => ({
  getStorage: async () => {
    const { LocalFileStorage } = await import("@/lib/storage/local");
    return new LocalFileStorage(join(storageRoot, "storage"));
  },
}));

beforeEach(() => {
  storageRoot = mkdtempSync(join(tmpdir(), "libi-snap-api-"));
  process.env.LIBI_HOME = storageRoot;
  mkdirSync(join(storageRoot, "storage", PIECE_ID), { recursive: true });
  writeFileSync(
    join(storageRoot, "storage", PIECE_ID, "composition.json"),
    JSON.stringify({ width: 1920, height: 1080, fps: 30, audioClips: [], overlays: [], scenes: [] }),
  );
  db = createTestDb();
  db.insert(pieces).values({ id: PIECE_ID, name: "Snap Test Piece" }).run();
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  resetTestDb();
  rmSync(storageRoot, { recursive: true, force: true });
});

function makeReq(body?: unknown) {
  return new Request("http://t", {
    method: "POST",
    body: JSON.stringify(body ?? {}),
    headers: { "content-type": "application/json" },
  });
}

describe("snapshot API routes", () => {
  it("GET /state returns hasDraft false by default", async () => {
    const { GET: getState } = await import(
      "@/app/api/pieces/[pieceId]/snapshot/state/route"
    );
    const res = await getState(new Request("http://t"), {
      params: Promise.resolve({ pieceId: PIECE_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.hasDraft).toBe(false);
    expect(body.pieceId).toBe(PIECE_ID);
  });

  it("POST /commit clears hasDraft and returns snapshotId", async () => {
    const { POST: postCommit } = await import(
      "@/app/api/pieces/[pieceId]/snapshot/commit/route"
    );
    const { GET: getState } = await import(
      "@/app/api/pieces/[pieceId]/snapshot/state/route"
    );

    // Mark piece as having a draft before committing
    db.update(pieces).set({ hasDraft: true }).where(eq(pieces.id, PIECE_ID)).run();

    const res = await postCommit(makeReq({ summary: "initial commit" }), {
      params: Promise.resolve({ pieceId: PIECE_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.snapshotId).toBeDefined();
    expect(body.summary).toBe("initial commit");

    // State should now show hasDraft: false
    const stateRes = await getState(new Request("http://t"), {
      params: Promise.resolve({ pieceId: PIECE_ID }),
    });
    const state = await stateRes.json();
    expect(state.hasDraft).toBe(false);
  });

  it("POST /discard requires confirm:true", async () => {
    const { POST: postDiscard } = await import(
      "@/app/api/pieces/[pieceId]/snapshot/discard/route"
    );

    // Missing confirm field — must return 400
    const badRes = await postDiscard(makeReq({}), {
      params: Promise.resolve({ pieceId: PIECE_ID }),
    });
    expect(badRes.status).toBe(400);

    // With confirm: true — should succeed
    const goodRes = await postDiscard(makeReq({ confirm: true }), {
      params: Promise.resolve({ pieceId: PIECE_ID }),
    });
    expect(goodRes.status).toBe(200);
    const body = await goodRes.json();
    expect(body.ok).toBe(true);
  });
});
