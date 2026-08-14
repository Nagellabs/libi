/**
 * I1 close-out — one-time boot sweep backfilling `has_alpha` for pre-fix rows.
 *
 * Migration 0044 left every existing row `has_alpha = NULL`, and every
 * consumer reads NULL as opaque — so a cutout stored BEFORE alpha-awareness
 * landed keeps its alpha-stripping proxy and exports opaque. The sweep
 * re-probes `type='video' AND has_alpha IS NULL` rows once, records the
 * truth, and drops the (alpha-stripped) proxy of any row that probes alpha.
 * Idempotent: backfilled rows are non-NULL and never probed again.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "./../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/ffmpeg/probe", () => ({ probeMedia: vi.fn() }));

import { getDb } from "@/lib/db/client";
import { probeMedia } from "@/lib/ffmpeg/probe";
import { files } from "@/lib/db/schema/sqlite";
import { eq } from "drizzle-orm";
import { sweepBackfillHasAlpha } from "@/lib/proxy/backfill-alpha";

let tmp: string;

function seedFile(
  db: ReturnType<typeof createTestDb>,
  id: string,
  filename: string,
  opts: {
    type?: string;
    hasAlpha?: boolean | null;
    proxyFilename?: string | null;
    proxyStatus?: "idle" | "generating" | "ready" | "failed";
  } = {},
): void {
  db.insert(files)
    .values({
      id,
      pieceId: "p",
      filename,
      name: filename,
      description: "",
      type: opts.type ?? "video",
      storagePath: `p/${filename}`,
      size: 1,
      hasAlpha: opts.hasAlpha === undefined ? null : opts.hasAlpha,
      proxyFilename: opts.proxyFilename ?? null,
      proxyStatus: opts.proxyStatus ?? "idle",
    })
    .run();
}

function writeSource(filename: string): void {
  const dir = path.join(tmp, "storage", "p");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), Buffer.alloc(8));
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-alpha-backfill-"));
  process.env.LIBI_HOME = tmp;
  delete process.env.STORAGE_DIR;
  const db = createTestDb();
  vi.mocked(getDb).mockReturnValue(db as never);
  seedPiece(db as never, { id: "p" });
  vi.mocked(probeMedia).mockReset();
});
afterEach(() => {
  resetTestDb();
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("sweepBackfillHasAlpha", () => {
  it("backfills a NULL row that probes alpha AND drops its stale proxy", async () => {
    const db = vi.mocked(getDb)();
    seedFile(db, "cutout", "cutout.webm", {
      hasAlpha: null,
      proxyFilename: "cutout-proxy.mp4",
      proxyStatus: "ready",
    });
    writeSource("cutout.webm");
    writeSource("cutout-proxy.mp4");
    vi.mocked(probeMedia).mockResolvedValue({ hasAlpha: true, videoCodec: "vp9" });

    await sweepBackfillHasAlpha();

    const row = db.select().from(files).where(eq(files.id, "cutout")).all()[0];
    expect(row.hasAlpha).toBe(true);
    // The alpha-stripped proxy is dropped: columns cleared + file unlinked.
    expect(row.proxyFilename).toBeNull();
    expect(row.proxyStatus).toBe("idle");
    expect(fs.existsSync(path.join(tmp, "storage", "p", "cutout-proxy.mp4"))).toBe(false);
    // Original bytes untouched.
    expect(fs.existsSync(path.join(tmp, "storage", "p", "cutout.webm"))).toBe(true);
  });

  it("backfills a NULL row that probes opaque to false and KEEPS its proxy", async () => {
    const db = vi.mocked(getDb)();
    seedFile(db, "clip", "clip.mp4", {
      hasAlpha: null,
      proxyFilename: "clip-proxy.mp4",
      proxyStatus: "ready",
    });
    writeSource("clip.mp4");
    writeSource("clip-proxy.mp4");
    vi.mocked(probeMedia).mockResolvedValue({ hasAlpha: false, videoCodec: "h264" });

    await sweepBackfillHasAlpha();

    const row = db.select().from(files).where(eq(files.id, "clip")).all()[0];
    expect(row.hasAlpha).toBe(false);
    expect(row.proxyFilename).toBe("clip-proxy.mp4");
    expect(row.proxyStatus).toBe("ready");
    expect(fs.existsSync(path.join(tmp, "storage", "p", "clip-proxy.mp4"))).toBe(true);
  });

  it("skips rows that already have has_alpha set, non-video rows, and missing sources", async () => {
    const db = vi.mocked(getDb)();
    seedFile(db, "known", "known.mp4", { hasAlpha: false });
    writeSource("known.mp4");
    seedFile(db, "img", "pic.png", { type: "image", hasAlpha: null });
    writeSource("pic.png");
    seedFile(db, "gone", "gone.mp4", { hasAlpha: null }); // no bytes on disk

    await sweepBackfillHasAlpha();

    expect(vi.mocked(probeMedia)).not.toHaveBeenCalled();
    const gone = db.select().from(files).where(eq(files.id, "gone")).all()[0];
    expect(gone.hasAlpha).toBeNull(); // stays unknown; consumers already read NULL as opaque
  });

  it("drops the stale proxy of a row ALREADY known alpha (has_alpha=1 + ready proxy)", async () => {
    // Wild state observed on a machine that ran this branch mid-fix: the row
    // got has_alpha=1 (store-time probe) but a proxy generated before the
    // runner guard landed is still `ready`. pickVideoUrl refuses it, but the
    // alpha-stripped file + `ready` status linger — the sweep tidies it.
    const db = vi.mocked(getDb)();
    seedFile(db, "known-alpha", "known-cutout.webm", {
      hasAlpha: true,
      proxyFilename: "known-cutout-proxy.mp4",
      proxyStatus: "ready",
    });
    writeSource("known-cutout.webm");
    writeSource("known-cutout-proxy.mp4");

    await sweepBackfillHasAlpha();

    expect(vi.mocked(probeMedia)).not.toHaveBeenCalled(); // no re-probe needed
    const row = db.select().from(files).where(eq(files.id, "known-alpha")).all()[0];
    expect(row.hasAlpha).toBe(true);
    expect(row.proxyFilename).toBeNull();
    expect(row.proxyStatus).toBe("idle");
    expect(fs.existsSync(path.join(tmp, "storage", "p", "known-cutout-proxy.mp4"))).toBe(false);
  });

  it("backfills a NULL row with NON-VPx alpha (ProRes 4444) and KEEPS its proxy", async () => {
    // Important 2 (pre-merge findings): preview cannot recover alpha for
    // non-VPx codecs — WebCodecs generally can't decode ProRes/qtrle at all —
    // so deleting the working scrub proxy would leave NO preview. An opaque
    // proxy is strictly better, and exports read the ORIGINAL regardless.
    const db = vi.mocked(getDb)();
    seedFile(db, "mograph", "mograph.mov", {
      hasAlpha: null,
      proxyFilename: "mograph-proxy.mp4",
      proxyStatus: "ready",
    });
    writeSource("mograph.mov");
    writeSource("mograph-proxy.mp4");
    vi.mocked(probeMedia).mockResolvedValue({ hasAlpha: true, videoCodec: "prores" });

    await sweepBackfillHasAlpha();

    const row = db.select().from(files).where(eq(files.id, "mograph")).all()[0];
    expect(row.hasAlpha).toBe(true); // truth recorded — exports still get alpha
    expect(row.proxyFilename).toBe("mograph-proxy.mp4"); // proxy KEPT
    expect(row.proxyStatus).toBe("ready");
    expect(fs.existsSync(path.join(tmp, "storage", "p", "mograph-proxy.mp4"))).toBe(true);
  });

  it("pass 0 KEEPS the proxy of an already-known-alpha row in a non-WebM container", async () => {
    // Same scoping for the stale-proxy tidy pass: only the VPx/WebM family
    // loses its proxy; a ProRes-style .mov alpha row keeps its working proxy.
    const db = vi.mocked(getDb)();
    seedFile(db, "known-prores", "graphics.mov", {
      hasAlpha: true,
      proxyFilename: "graphics-proxy.mp4",
      proxyStatus: "ready",
    });
    writeSource("graphics.mov");
    writeSource("graphics-proxy.mp4");

    await sweepBackfillHasAlpha();

    expect(vi.mocked(probeMedia)).not.toHaveBeenCalled();
    const row = db.select().from(files).where(eq(files.id, "known-prores")).all()[0];
    expect(row.proxyFilename).toBe("graphics-proxy.mp4");
    expect(row.proxyStatus).toBe("ready");
    expect(fs.existsSync(path.join(tmp, "storage", "p", "graphics-proxy.mp4"))).toBe(true);
  });

  it("leaves the row NULL when the probe cannot determine alpha (unknown ≠ guessed)", async () => {
    const db = vi.mocked(getDb)();
    seedFile(db, "odd", "odd.mp4", { hasAlpha: null });
    writeSource("odd.mp4");
    vi.mocked(probeMedia).mockResolvedValue({}); // ffprobe missing / unreadable file

    await sweepBackfillHasAlpha();

    const row = db.select().from(files).where(eq(files.id, "odd")).all()[0];
    expect(row.hasAlpha).toBeNull();
  });
});
