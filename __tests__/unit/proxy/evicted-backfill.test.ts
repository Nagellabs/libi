/**
 * One-time backfill of eviction records (review n2). 0.1.16's LRU evicted
 * video proxies without recording them, and the re-make on open
 * (lib/proxy/ensure.ts) only re-makes a recorded one. On the first boot of
 * this version, an idle video row with no proxy whose proxy_gen job COMPLETED
 * (it had a proxy once) and whose original is on disk is recorded. Excluded:
 * the onboarding clips (stored with skipProxyGeneration: no proxy_gen job at
 * all), a failed job, VPx alpha (by probed codec), audio (0.1.16 never evicted
 * it), a missing original. It runs once (marker).
 *
 * Review FINAL I1: the record is the proxy's ESTIMATED size (duration × the
 * proxy's estimated bitrate, capped at the original), not the original's. v1
 * recorded the original's size, so a 5 GB 4K original never fit the 4 GB
 * budget and its proxy stayed pending for good. The v2 marker re-estimates
 * the records v1 wrote (size == the original's) on a home where it ran.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { files, jobs } from "@/lib/db/schema/sqlite";
import { getDb } from "@/lib/db/client";

vi.mock("@/lib/ffmpeg/probe", () => ({
  // "vpx-*" files are VP9, the rest ProRes; "dur<N>-*" files probe as N seconds long.
  probeMedia: vi.fn(async (p: string) => {
    const name = path.basename(p);
    const dur = /^dur(\d+)-/.exec(name);
    return { videoCodec: name.startsWith("vpx-") ? "vp9" : "prores", ...(dur ? { duration: Number(dur[1]) } : {}) };
  }),
}));

import { listEvictedProxies, forgetEvictedProxies } from "@/lib/proxy/evicted";
import { sweepBackfillEvictedProxies, PROXY_EVICTED_BACKFILL_MARKER } from "@/lib/proxy/backfill-evicted";
import { estimateProxyBytes } from "@/lib/proxy/args";
import { DEFAULT_PROXY_BYTE_BUDGET } from "@/lib/proxy/lru";

const GiB = 1024 * 1024 * 1024;

describe("sweepBackfillEvictedProxies", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-evicted-backfill-"));
    vi.stubEnv("LIBI_HOME", tmp);
    vi.stubEnv("STORAGE_DIR", path.join(tmp, "storage"));
    seedPiece(createTestDb(), { id: "p1" });
  });
  afterEach(() => {
    resetTestDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  let n = 0;
  function row(id: string, over: Partial<typeof files.$inferInsert> = {}, job?: "completed" | "failed", originalBytes = 1000) {
    const filename = over.filename ?? `${id}.mp4`;
    const dir = path.join(tmp, "storage", "p1");
    fs.mkdirSync(dir, { recursive: true });
    // Sparse: a 5 GB original costs no disk.
    fs.writeFileSync(path.join(dir, filename), "");
    fs.truncateSync(path.join(dir, filename), originalBytes);
    getDb().insert(files).values({ id, pieceId: "p1", filename, name: filename, description: "", type: "video", storagePath: `p1/${filename}`, proxyStatus: "idle", ...over }).run();
    if (job) {
      getDb().insert(jobs).values({ id: `job-${n++}`, kind: "proxy_gen", clientKey: `k${n}`, paramsHash: `h-${id}`, paramsJson: JSON.stringify({ fileId: id }), status: job, fileId: id, pieceId: "p1" }).run();
    }
  }

  it("records an idle video whose proxy was made once; nothing else", async () => {
    row("evicted", {}, "completed", 4321);
    row("clip-onboarding"); // skipProxyGeneration: never had a job
    row("failed-job", {}, "failed");
    row("ready", { proxyStatus: "ready", proxyFilename: "ready-proxy.mp4" }, "completed");
    row("vpx", { filename: "vpx-cut.mov", hasAlpha: true }, "completed");
    row("prores", { filename: "prores-cut.mov", hasAlpha: true }, "completed");
    row("song", { type: "audio", filename: "song.m4a" }, "completed");
    row("gone", {}, "completed");
    fs.rmSync(path.join(tmp, "storage", "p1", "gone.mp4"));

    const r = await sweepBackfillEvictedProxies();
    expect(Object.keys(listEvictedProxies()).sort()).toEqual(["evicted", "prores"]);
    // Duration unknown (no media_duration, nothing probed): the capped fallback, here the original.
    expect(listEvictedProxies().evicted.bytes).toBe(4321);
    expect(r).toEqual({ recorded: 2, reestimated: 0 });
    expect(fs.existsSync(path.join(tmp, "state", PROXY_EVICTED_BACKFILL_MARKER))).toBe(true);
  });

  it("runs once: its marker stops it", async () => {
    row("evicted", {}, "completed");
    await sweepBackfillEvictedProxies();
    forgetEvictedProxies(["evicted"]); // e.g. re-made since
    expect(await sweepBackfillEvictedProxies()).toEqual({ recorded: 0, reestimated: 0 });
    expect(listEvictedProxies()).toEqual({});
  });

  it("keeps a record the LRU already wrote (its real size)", async () => {
    row("evicted", {}, "completed", 5000);
    const { recordEvictedProxy } = await import("@/lib/proxy/evicted");
    recordEvictedProxy("evicted", 777);
    await sweepBackfillEvictedProxies();
    expect(listEvictedProxies().evicted.bytes).toBe(777);
  });

  describe("review FINAL I1: the record is the proxy's estimated size, not the original's", () => {
    it("a 5 GB 4K original: recorded at duration × the proxy bitrate, which fits the 4 GB budget", async () => {
      row("big", { mediaDuration: 1200, mediaWidth: 3840, mediaHeight: 2160 }, "completed", 5 * GiB);
      await sweepBackfillEvictedProxies();
      const bytes = listEvictedProxies().big.bytes;
      expect(bytes).toBe(estimateProxyBytes(1200));
      expect(bytes).toBeLessThan(5 * GiB);
      expect(bytes).toBeLessThanOrEqual(DEFAULT_PROXY_BYTE_BUDGET);
    });

    it("never more than the original (a short, small clip)", async () => {
      row("small", { mediaDuration: 8 }, "completed", 2000);
      await sweepBackfillEvictedProxies();
      expect(listEvictedProxies().small.bytes).toBe(2000);
    });

    it("no media_duration: the probed duration", async () => {
      row("probed", { filename: "dur600-cut.mp4" }, "completed", 5 * GiB);
      await sweepBackfillEvictedProxies();
      expect(listEvictedProxies().probed.bytes).toBe(estimateProxyBytes(600));
    });

    it("duration unknown: min(original, budget / ENSURE_MAX_PER_PASS), never 0", async () => {
      row("unknown", {}, "completed", 5 * GiB);
      row("empty", {}, "completed", 0);
      await sweepBackfillEvictedProxies();
      expect(listEvictedProxies().unknown.bytes).toBe(GiB);
      expect(listEvictedProxies().empty.bytes).toBeGreaterThan(0);
    });

    it("a home where v1 ran: its original-sized records are re-estimated, an LRU record is kept, and it is idempotent", async () => {
      row("big", { mediaDuration: 1200, mediaHeight: 2160 }, "completed", 5 * GiB);
      row("lru", { mediaDuration: 1200 }, "completed", 5 * GiB);
      const { recordEvictedProxy } = await import("@/lib/proxy/evicted");
      recordEvictedProxy("big", 5 * GiB); // what v1 wrote
      recordEvictedProxy("lru", 300_000_000); // the LRU's real size
      fs.mkdirSync(path.join(tmp, "state"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "state", "proxy-evicted-backfill-v1"), "2026-09-26T00:00:00.000Z recorded=1\n");

      expect(await sweepBackfillEvictedProxies()).toEqual({ recorded: 0, reestimated: 1 });
      expect(listEvictedProxies().big.bytes).toBe(estimateProxyBytes(1200));
      expect(listEvictedProxies().lru.bytes).toBe(300_000_000);
      expect(fs.readFileSync(path.join(tmp, "state", PROXY_EVICTED_BACKFILL_MARKER), "utf8")).toMatch(/recorded=0 reestimated=1/);

      const before = listEvictedProxies();
      expect(await sweepBackfillEvictedProxies()).toEqual({ recorded: 0, reestimated: 0 });
      expect(listEvictedProxies()).toEqual(before);
    });

    it("the marker is v2", () => {
      expect(PROXY_EVICTED_BACKFILL_MARKER).toBe("proxy-evicted-backfill-v2");
    });
  });
});
