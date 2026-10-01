/**
 * The transcript re-time boot sweep (lib/analysis/retime-audio-lead.ts), its
 * review round 5 fixes, with the probe stubbed (the real-ffmpeg run is
 * __tests__/integration/transcript-retime-audio-lead.test.ts):
 * - M1: every audio.wav without its timeline sidecar is dropped, a stamped
 *   transcript's included, and the transcript is left as it is; where 0.1.16's
 *   v1 run already happened, the v2 run drops stale extracts only and moves no
 *   transcript.
 * - M2: a file whose probe fails is retried on the next boot, not marked done;
 *   after 3 failing boots it is given up on (listed) so the sweep can end.
 * - M3: a file with several audio tracks whose leads differ is skipped and
 *   logged: which track the old extract read (ffmpeg's default pick) is not
 *   known, so neither is the shift.
 * - M7: a removed (FLAC-in-MP4) transcript is named: a warn line with the
 *   file's name, and a notice the piece's next open reports once.
 * - Review I1: a later boot's retry re-times only the transcripts the first
 *   run found unstamped, untouched since; one made (or touched) between boots
 *   is on the file's timeline and is never shifted. The fixed code stamps a
 *   transcript step when it creates it and never wipes the stamp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { analysisAudioChunks, analysisSteps, files } from "@/lib/db/schema";
import type { ProbeResult } from "@/lib/ffmpeg/probe";

const probes = vi.hoisted(() => ({ byName: new Map<string, ProbeResult>(), calls: [] as string[] }));
vi.mock("@/lib/ffmpeg/probe", () => {
  const probeMediaResult = async (p: string): Promise<ProbeResult> => {
    probes.calls.push(path.basename(p));
    return probes.byName.get(path.basename(p)) ?? { ok: true, media: {} };
  };
  return {
    probeMediaResult,
    probeMedia: async (p: string) => {
      const r = await probeMediaResult(p);
      return r.ok ? r.media : {};
    },
  };
});

import { getDb } from "@/lib/db/client";
import { serverLogger } from "@/lib/logger";
import { getAudioChunksDir, getAudioPath, getAudioTimelinePath } from "@/lib/analysis/storage";
import { chunkAudio, markAudioChunkFailed } from "@/lib/analysis/manager";
import {
  RETIME_CANDIDATES_FILE,
  sweepRetimeAudioLeadTranscripts,
  AUDIO_LEAD_RETIME_MARKER,
  AUDIO_LEAD_RETIME_MARKER_V1,
  RETIME_UNRESOLVED_FILE,
} from "@/lib/analysis/retime-audio-lead";

const LONG_AGO = new Date("2026-09-01T00:00:00Z");

describe("sweepRetimeAudioLeadTranscripts", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-retime-unit-"));
    vi.stubEnv("LIBI_HOME", tmp);
    vi.stubEnv("STORAGE_DIR", path.join(tmp, "storage"));
    probes.byName.clear();
    probes.calls = [];
    const db = createTestDb();
    seedPiece(db, { id: "p1" });
  });
  afterEach(() => {
    resetTestDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const lead = (s: number): ProbeResult => ({ ok: true, media: { hasAudio: true, audioLead: s } });

  /** A file with a Whisper transcript (one chunk), and an audio.wav extracted before this boot. */
  function transcribed(id: string, opts: { stamped?: boolean; sidecar?: boolean; wav?: boolean } = {}) {
    const db = getDb();
    db.insert(files).values({ id, pieceId: "p1", filename: `${id}.mp4`, name: `${id}.mp4`, description: "", type: "video", storagePath: `p1/${id}.mp4`, mediaDuration: 3 }).run();
    const meta = { schema_version: "transcript_v1", provider: "whisper", words: [{ text: "hi", start: 0.1, end: 0.5 }], ...(opts.stamped ? { audioTimeline: "file" } : {}) };
    const [step] = db.insert(analysisSteps).values({ fileId: id, pieceId: "p1", kind: "transcript", status: "ready", content: "hi", metadata: JSON.stringify(meta), updatedAt: LONG_AGO }).returning().all();
    db.insert(analysisAudioChunks).values({ fileId: id, stepId: step.id, chunkIndex: 0, startSeconds: 0, endSeconds: 3, filePath: "audio-chunks/chunk-0001.wav", status: "ready", text: "hi", words: JSON.stringify([{ text: "hi", start: 0.1, end: 0.5 }]) }).run();
    if (opts.wav !== false) {
      fs.mkdirSync(getAudioChunksDir("p1", id), { recursive: true });
      fs.writeFileSync(getAudioPath("p1", id), "old");
      fs.writeFileSync(path.join(getAudioChunksDir("p1", id), "chunk-0001.wav"), "old");
      if (opts.sidecar) fs.writeFileSync(getAudioTimelinePath("p1", id), "file\n");
      fs.utimesSync(getAudioPath("p1", id), LONG_AGO, LONG_AGO); // extracted before this server started
    }
  }
  const meta = (id: string) => {
    const [s] = getDb().select().from(analysisSteps).where(eq(analysisSteps.fileId, id)).all();
    return s ? (JSON.parse(s.metadata!) as { words: Array<{ start: number }>; audioTimeline?: string }) : null;
  };
  const marker = (name = AUDIO_LEAD_RETIME_MARKER) => path.join(tmp, "state", name);

  describe("M1: stale audio.wav", () => {
    it("drops a stamped transcript's sidecar-less audio.wav, and leaves the transcript alone", async () => {
      transcribed("f-stamped", { stamped: true });
      probes.byName.set("f-stamped.mp4", lead(0.4));
      await sweepRetimeAudioLeadTranscripts();
      expect(fs.existsSync(getAudioPath("p1", "f-stamped"))).toBe(false);
      expect(fs.existsSync(getAudioChunksDir("p1", "f-stamped"))).toBe(false);
      expect(meta("f-stamped")!.words[0].start).toBe(0.1);
      expect(meta("f-stamped")!.audioTimeline).toBe("file");
    });

    it("keeps an audio.wav whose sidecar says it is on the file's timeline", async () => {
      transcribed("f-current", { stamped: true, sidecar: true });
      await sweepRetimeAudioLeadTranscripts();
      expect(fs.existsSync(getAudioPath("p1", "f-current"))).toBe(true);
    });

    it("keeps an audio.wav written since the server started (an extract still being written)", async () => {
      transcribed("f-writing", { stamped: true });
      const now = new Date();
      fs.utimesSync(getAudioPath("p1", "f-writing"), now, now);
      await sweepRetimeAudioLeadTranscripts();
      expect(fs.existsSync(getAudioPath("p1", "f-writing"))).toBe(true);
    });

    it("drops a stale audio.wav of a file with no transcript at all", async () => {
      getDb().insert(files).values({ id: "f-bare", pieceId: "p1", filename: "bare.mp4", name: "bare.mp4", description: "", type: "video", storagePath: "p1/bare.mp4" }).run();
      fs.mkdirSync(path.dirname(getAudioPath("p1", "f-bare")), { recursive: true });
      fs.writeFileSync(getAudioPath("p1", "f-bare"), "old");
      fs.utimesSync(getAudioPath("p1", "f-bare"), LONG_AGO, LONG_AGO);
      const r = await sweepRetimeAudioLeadTranscripts();
      expect(fs.existsSync(getAudioPath("p1", "f-bare"))).toBe(false);
      expect(r.droppedExtracts).toBe(1);
    });

    it("full run (v1 never ran): moves an unstamped transcript by its lead", async () => {
      transcribed("f-late");
      probes.byName.set("f-late.mp4", lead(0.4));
      const r = await sweepRetimeAudioLeadTranscripts();
      expect(r.mode).toBe("full");
      expect(meta("f-late")!.words[0].start).toBeCloseTo(0.5, 6);
      expect(fs.readFileSync(marker(), "utf8")).toMatch(/mode=full retimed=1/);
    });

    it("after 0.1.16's v1 run: drops stale extracts, moves no transcript, probes nothing", async () => {
      fs.mkdirSync(path.join(tmp, "state"), { recursive: true });
      fs.writeFileSync(marker(AUDIO_LEAD_RETIME_MARKER_V1), "2026-09-26 retimed=0 removed=0\n");
      transcribed("f-unstamped"); // made after v1 without a stamp: can't be told from an early one
      transcribed("f-stamped-early", { stamped: true });
      probes.byName.set("f-unstamped.mp4", lead(0.4));
      probes.byName.set("f-stamped-early.mp4", lead(0.4));
      const r = await sweepRetimeAudioLeadTranscripts();
      expect(r).toEqual({ mode: "extracts-only", retimed: 0, removed: 0, droppedExtracts: 2, unresolved: 0, gaveUp: 0, multitrack: 0 });
      expect(meta("f-unstamped")!.words[0].start).toBe(0.1);
      expect(meta("f-stamped-early")!.words[0].start).toBe(0.1);
      expect(fs.existsSync(getAudioPath("p1", "f-unstamped"))).toBe(false);
      expect(fs.existsSync(getAudioPath("p1", "f-stamped-early"))).toBe(false);
      expect(probes.calls).toEqual([]);
      expect(fs.readFileSync(marker(), "utf8")).toMatch(/mode=extracts-only droppedExtracts=2/);
    });

    it("the v2 marker stops it", async () => {
      await sweepRetimeAudioLeadTranscripts();
      transcribed("f-after");
      probes.byName.set("f-after.mp4", lead(0.4));
      expect((await sweepRetimeAudioLeadTranscripts()).mode).toBe("done");
      expect(meta("f-after")!.words[0].start).toBe(0.1);
      expect(fs.existsSync(getAudioPath("p1", "f-after"))).toBe(true);
    });
  });

  describe("M2: a failed probe", () => {
    it("is retried on the next boot, not marked done; the third failing boot gives up on it and writes the marker", async () => {
      transcribed("f-bad");
      transcribed("f-late");
      probes.byName.set("f-bad.mp4", { ok: false, failure: "timeout" });
      probes.byName.set("f-late.mp4", lead(0.4));
      const warn = vi.spyOn(serverLogger, "warn");
      const failedLines = () =>
        warn.mock.calls.filter((c) => (c[0] as { op?: string }).op === "transcript_retime_probe_failed");

      // Boot 1: the good file is re-timed, the bad one is unresolved: no marker.
      const r1 = await sweepRetimeAudioLeadTranscripts();
      expect(r1).toMatchObject({ mode: "full", retimed: 1, unresolved: 1 });
      expect(fs.existsSync(marker())).toBe(false);
      expect(failedLines()).toHaveLength(1);
      expect(failedLines()[0][0]).toMatchObject({ tag: "analysis", fileId: "f-bad", failure: "timeout" });
      expect(meta("f-bad")!.words[0].start).toBe(0.1);

      // Boot 2: the bad file is probed again (the re-timed one is not moved twice).
      probes.calls = [];
      const r2 = await sweepRetimeAudioLeadTranscripts();
      expect(probes.calls).toEqual(["f-bad.mp4"]);
      expect(r2).toMatchObject({ retimed: 0, unresolved: 1 });
      expect(fs.existsSync(marker())).toBe(false);
      expect(meta("f-late")!.words[0].start).toBeCloseTo(0.5, 6);

      // Boot 3: still failing: given up on, listed, and the sweep is done.
      const r3 = await sweepRetimeAudioLeadTranscripts();
      expect(r3).toMatchObject({ unresolved: 0, gaveUp: 1 });
      expect(fs.readFileSync(marker(), "utf8")).toMatch(/gaveUp=1/);
      const listed = JSON.parse(fs.readFileSync(path.join(tmp, "state", RETIME_UNRESOLVED_FILE), "utf8"));
      expect(listed["f-bad"]).toMatchObject({ attempts: 3, failure: "timeout", gaveUp: true });
      expect(failedLines()).toHaveLength(3); // once per boot
      warn.mockRestore();
    });

    it("a file that probes on a later boot is re-timed and leaves the list", async () => {
      transcribed("f-flaky");
      probes.byName.set("f-flaky.mp4", { ok: false, failure: "unreadable" });
      await sweepRetimeAudioLeadTranscripts();
      expect(fs.existsSync(marker())).toBe(false);
      probes.byName.set("f-flaky.mp4", lead(0.4));
      const r = await sweepRetimeAudioLeadTranscripts();
      expect(r).toMatchObject({ retimed: 1, unresolved: 0, gaveUp: 0 });
      expect(meta("f-flaky")!.words[0].start).toBeCloseTo(0.5, 6);
      expect(fs.existsSync(marker())).toBe(true);
      expect(fs.existsSync(path.join(tmp, "state", RETIME_UNRESOLVED_FILE))).toBe(false);
    });
    it("an unresolved entry whose file row is gone is dropped from the file", async () => {
      transcribed("f-gone");
      probes.byName.set("f-gone.mp4", { ok: false, failure: "timeout" });
      await sweepRetimeAudioLeadTranscripts();
      const listPath = path.join(tmp, "state", RETIME_UNRESOLVED_FILE);
      expect(JSON.parse(fs.readFileSync(listPath, "utf8"))["f-gone"]).toBeDefined();

      // The file is deleted between boots: its entry must not be written back.
      getDb().delete(files).where(eq(files.id, "f-gone")).run();
      const r = await sweepRetimeAudioLeadTranscripts();
      expect(r).toMatchObject({ unresolved: 0, gaveUp: 0 });
      expect(fs.existsSync(listPath)).toBe(false);
    });
  });

  describe("M3: several audio tracks", () => {
    it("tracks that start at different times: not shifted, logged, counted in the marker", async () => {
      transcribed("f-multi");
      probes.byName.set("f-multi.mp4", { ok: true, media: { hasAudio: true, audioLead: 0.4, audioStreamLeads: [0, 0.4] } });
      const warn = vi.spyOn(serverLogger, "warn");
      const r = await sweepRetimeAudioLeadTranscripts();
      expect(r).toMatchObject({ retimed: 0, multitrack: 1 });
      expect(meta("f-multi")!.words[0].start).toBe(0.1);
      expect(meta("f-multi")!.audioTimeline).toBeUndefined();
      const line = warn.mock.calls.find((c) => (c[0] as { op?: string }).op === "transcript_retime_multitrack_skipped");
      expect(line?.[0]).toMatchObject({ tag: "analysis", fileId: "f-multi", leads: [0, 0.4] });
      expect(fs.readFileSync(marker(), "utf8")).toMatch(/multitrack=1/);
      warn.mockRestore();
    });

    it("tracks that start together: shifted as a single track is", async () => {
      transcribed("f-multi-even");
      probes.byName.set("f-multi-even.mp4", { ok: true, media: { hasAudio: true, audioLead: 0.4, audioStreamLeads: [0.4, 0.4] } });
      const r = await sweepRetimeAudioLeadTranscripts();
      expect(r).toMatchObject({ retimed: 1, multitrack: 0 });
      expect(meta("f-multi-even")!.words[0].start).toBeCloseTo(0.5, 6);
    });
  });

  describe("M7: a removed transcript is named", () => {
    const flacCut: ProbeResult = { ok: true, media: { hasAudio: true, audioCodec: "flac", audioRead: { inputArgs: ["-advanced_editlist", "0"], ptsShift: 0.02 } } };

    it("warns with the file's name, and the piece's next open reports it once", async () => {
      transcribed("f-flac");
      getDb().update(files).set({ name: "Interview take 3" }).where(eq(files.id, "f-flac")).run();
      probes.byName.set("f-flac.mp4", flacCut);
      const warn = vi.spyOn(serverLogger, "warn");
      const r = await sweepRetimeAudioLeadTranscripts();
      expect(r).toMatchObject({ removed: 1 });
      expect(meta("f-flac")).toBeNull();
      const line = warn.mock.calls.find((c) => (c[0] as { op?: string }).op === "transcript_retime_removed");
      expect(line?.[0]).toMatchObject({ tag: "analysis", fileId: "f-flac", filename: "f-flac.mp4", name: "Interview take 3", pieceId: "p1" });
      warn.mockRestore();

      const { GET } = await import("@/app/api/pieces/[pieceId]/composition/route");
      const { POST } = await import("@/app/api/pieces/[pieceId]/composition/removed-transcripts-notice/route");
      const load = async () =>
        (await (await GET(new Request("http://127.0.0.1/api/pieces/p1/composition"), { params: Promise.resolve({ pieceId: "p1" }) })).json()) as {
          removedTranscripts?: Array<{ fileId: string; name: string }>;
        };
      expect((await load()).removedTranscripts).toEqual([{ fileId: "f-flac", name: "Interview take 3" }]);
      const ack = await POST(
        new Request("http://127.0.0.1/api/pieces/p1/composition/removed-transcripts-notice", { method: "POST", body: JSON.stringify({ fileIds: ["f-flac"] }) }),
        { params: Promise.resolve({ pieceId: "p1" }) },
      );
      expect(ack.status).toBe(200);
      expect((await load()).removedTranscripts).toEqual([]);
    });

    it("a deleted file's notice goes with it, and the store is written whole (temp + rename) (review m4)", async () => {
      const { recordRemovedTranscript, pendingRemovedTranscripts, REMOVED_TRANSCRIPTS_FILE } = await import("@/lib/analysis/removed-transcripts");
      getDb().insert(files).values({ id: "f-a", pieceId: "p1", filename: "a.mp4", name: "A", description: "", type: "video", storagePath: "p1/a.mp4" }).run();
      getDb().insert(files).values({ id: "f-b", pieceId: "p1", filename: "b.mp4", name: "B", description: "", type: "video", storagePath: "p1/b.mp4" }).run();
      recordRemovedTranscript("p1", { fileId: "f-a", name: "A" });
      recordRemovedTranscript("p1", { fileId: "f-b", name: "B" });
      const { deleteFile } = await import("@/lib/files/delete-file");
      expect((await deleteFile("f-a")).success).toBe(true);
      expect(pendingRemovedTranscripts("p1").map((e) => e.fileId)).toEqual(["f-b"]);
      const stored = JSON.parse(fs.readFileSync(path.join(tmp, "state", REMOVED_TRANSCRIPTS_FILE), "utf8"));
      expect(stored.p1.map((e: { fileId: string }) => e.fileId)).toEqual(["f-b"]);
      expect(fs.readdirSync(path.join(tmp, "state")).filter((n) => n.endsWith(".tmp"))).toEqual([]);
      // A file gone without deleteFile (its row removed) is not named either.
      getDb().delete(files).where(eq(files.id, "f-b")).run();
      expect(pendingRemovedTranscripts("p1")).toEqual([]);
    });

    it("a library file's removal is told on the next open of any piece; a deleted piece's entries go with it", async () => {
      const { recordRemovedTranscript, pendingRemovedTranscripts, forgetRemovedTranscriptsForPiece } = await import("@/lib/analysis/removed-transcripts");
      getDb().insert(files).values({ id: "g1", pieceId: null, filename: "g.mp4", name: "Library clip", description: "", type: "video", storagePath: "_global/g.mp4" }).run();
      getDb().insert(files).values({ id: "f1", pieceId: "p1", filename: "f.mp4", name: "Piece clip", description: "", type: "video", storagePath: "p1/f.mp4" }).run();
      recordRemovedTranscript(null, { fileId: "g1", name: "Library clip" });
      recordRemovedTranscript("p1", { fileId: "f1", name: "Piece clip" });
      recordRemovedTranscript("p1", { fileId: "f1", name: "Piece clip" }); // idempotent
      expect(pendingRemovedTranscripts("p1").map((e) => e.fileId)).toEqual(["f1", "g1"]);
      expect(pendingRemovedTranscripts("p2").map((e) => e.fileId)).toEqual(["g1"]);
      forgetRemovedTranscriptsForPiece("p1");
      expect(pendingRemovedTranscripts("p1").map((e) => e.fileId)).toEqual(["g1"]);
    });
  });

  describe("review I1: a transcript made between boots is never shifted", () => {
    it("the reviewer's repro: boot 1 leaves a file unresolved; a partial transcript made after it keeps its word at 0.5 s on boot 2", async () => {
      transcribed("f-bad");
      probes.byName.set("f-bad.mp4", { ok: false, failure: "unreadable" });
      const r1 = await sweepRetimeAudioLeadTranscripts();
      expect(r1.unresolved).toBe(1);
      expect(fs.existsSync(path.join(tmp, "state", RETIME_CANDIDATES_FILE))).toBe(true);

      // Between boots: a transcript on the file's timeline, unstamped, one chunk failed.
      getDb().insert(files).values({ id: "f-new", pieceId: "p1", filename: "f-new.mp4", name: "f-new", description: "", type: "video", storagePath: "p1/f-new.mp4", mediaDuration: 3 }).run();
      const [step] = getDb().insert(analysisSteps).values({ fileId: "f-new", pieceId: "p1", kind: "transcript", status: "failed", metadata: null }).returning().all();
      getDb().insert(analysisAudioChunks).values({ fileId: "f-new", stepId: step.id, chunkIndex: 0, startSeconds: 0, endSeconds: 3, filePath: "audio-chunks/chunk-0001.wav", status: "ready", text: "hi", words: JSON.stringify([{ text: "hi", start: 0.5, end: 0.9 }]) }).run();
      probes.byName.set("f-new.mp4", lead(0.4));

      await sweepRetimeAudioLeadTranscripts(); // boot 2
      const c = getDb().select().from(analysisAudioChunks).where(eq(analysisAudioChunks.fileId, "f-new")).all()[0];
      expect(JSON.parse(c.words!)[0].start).toBe(0.5);
      expect(c.startSeconds).toBe(0);
    });

    it("a first-run transcript touched between boots (a retry) is left as it is, and doesn't hold the marker back", async () => {
      transcribed("f-bad");
      transcribed("f-retried");
      probes.byName.set("f-bad.mp4", { ok: false, failure: "timeout" });
      probes.byName.set("f-retried.mp4", { ok: false, failure: "timeout" });
      await sweepRetimeAudioLeadTranscripts();
      // Between boots: f-retried's transcript is worked on (its row moves on).
      getDb().update(analysisSteps).set({ updatedAt: new Date(Date.now() + 5000) }).where(eq(analysisSteps.fileId, "f-retried")).run();
      probes.byName.set("f-bad.mp4", lead(0.4));
      probes.byName.set("f-retried.mp4", lead(0.4));
      const r2 = await sweepRetimeAudioLeadTranscripts();
      expect(meta("f-bad")!.words[0].start).toBeCloseTo(0.5, 6); // untouched since boot 1: re-timed
      expect(meta("f-retried")!.words[0].start).toBe(0.1); // touched: not shifted
      expect(r2).toMatchObject({ unresolved: 0, retimed: 1 });
      expect(fs.existsSync(marker())).toBe(true);
      expect(fs.existsSync(path.join(tmp, "state", RETIME_CANDIDATES_FILE))).toBe(false);
    });

    it("the fixed code stamps a transcript step it creates, and a chunk failure or re-chunk never wipes the stamp", async () => {
      getDb().insert(files).values({ id: "f-fresh", pieceId: "p1", filename: "f-fresh.mp4", name: "f-fresh", description: "", type: "video", storagePath: "p1/f-fresh.mp4", mediaDuration: 3 }).run();
      const { chunks } = await chunkAudio({ fileId: "f-fresh", skipExtraction: true });
      expect(meta("f-fresh")?.audioTimeline).toBe("file");
      await markAudioChunkFailed({ chunkId: chunks[0].chunkId, errorMessage: "boom" });
      expect(meta("f-fresh")?.audioTimeline).toBe("file");
      await chunkAudio({ fileId: "f-fresh", skipExtraction: true }); // a retry re-plans
      expect(meta("f-fresh")?.audioTimeline).toBe("file");
    });

    it("a pre-fix (unstamped) transcript re-chunked by the new code is not stamped by it", async () => {
      transcribed("f-old");
      await chunkAudio({ fileId: "f-old", skipExtraction: true });
      expect(meta("f-old")?.audioTimeline).toBeUndefined();
    });
  });

  describe("review n5: two servers on one home", () => {
    it("a step another server re-timed while this one probed is not shifted again", async () => {
      transcribed("f-race");
      probes.byName.set("f-race.mp4", lead(0.4));
      // While this sweep probes, another studio on the same home shifts and stamps the step.
      const { probeMediaResult } = await import("@/lib/ffmpeg/probe");
      const real = probeMediaResult as unknown as (p: string) => Promise<ProbeResult>;
      const mod = await import("@/lib/ffmpeg/probe");
      const spy = vi.spyOn(mod, "probeMediaResult").mockImplementation(async (p: string) => {
        const [st] = getDb().select().from(analysisSteps).where(eq(analysisSteps.fileId, "f-race")).all();
        const m = JSON.parse(st.metadata!);
        m.words = m.words.map((w: { start: number; end: number }) => ({ ...w, start: w.start + 0.4, end: w.end + 0.4 }));
        m.audioTimeline = "file";
        getDb().update(analysisSteps).set({ metadata: JSON.stringify(m) }).where(eq(analysisSteps.id, st.id)).run();
        return real(p);
      });
      const r = await sweepRetimeAudioLeadTranscripts();
      spy.mockRestore();
      expect(meta("f-race")!.words[0].start).toBeCloseTo(0.5, 6); // once, not 0.9
      expect(r.retimed).toBe(0);
    });
  });
});
