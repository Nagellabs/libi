/**
 * AUD-4 review I2 — the HE-AAC check's ffprobe can fail or time out (a slow
 * mount, boot-time contention). That answer is UNKNOWN, never "not HE-AAC":
 *   - it is logged {tag:"proxy", op:"aac_profile_probe_failed"};
 *   - the timing route serves it but must not cache it (`cacheable: false`);
 *   - the audio-preview sweep leaves its marker unwritten, and judges the file
 *     again next boot while skipping the files it already settled.
 * (The upload side is in store-file-audio-proxy.test.ts.)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, resetTestDb, seedPiece } from "../../helpers/test-db";
import { files } from "@/lib/db/schema/sqlite";

/** How the HE-AAC ffprobe call answers: a timeout, or this stream. */
const ff = vi.hoisted(() => ({
  mode: "timeout" as "timeout" | "lc",
  /** Files whose probe times out whatever `mode` says. */
  slow: new Set<string>(),
  aacCalls: [] as string[],
}));
vi.mock("child_process", () => ({
  execFile: (...callArgs: unknown[]) => {
    const args = callArgs[1] as string[];
    const cb = callArgs[callArgs.length - 1] as (err: unknown, out?: { stdout: string; stderr: string }) => void;
    if (!args.includes("stream=profile,extradata")) return cb(new Error(`unexpected ffprobe ${args.join(" ")}`));
    const file = String(args[args.length - 1]);
    ff.aacCalls.push(file);
    if (ff.mode === "timeout" || [...ff.slow].some((n) => file.endsWith(n))) {
      return cb(Object.assign(new Error("Command failed: ffprobe (timed out)"), { killed: true, signal: "SIGKILL" }));
    }
    cb(null, { stdout: JSON.stringify({ streams: [{ profile: "LC", extradata: "\n00000000: 1290    ..\n" }] }), stderr: "" });
  },
}));

const AAC_AUDIO_ONLY = { hasAudio: true, audioCodec: "aac", formatName: "mov,mp4,m4a,3gp,3g2,mj2", primaryAudioStreamIndex: 0 };
vi.mock("@/lib/ffmpeg/probe", () => ({
  probeMedia: vi.fn(async () => AAC_AUDIO_ONLY),
  probeMediaResult: vi.fn(async () => ({ ok: true, media: AAC_AUDIO_ONLY })),
  readOpusDiscards: vi.fn(async () => ({ ok: true, trims: [] })),
}));

const warn = vi.hoisted(() => vi.fn());
vi.mock("@/lib/logger", async (orig) => {
  const mod = await orig<typeof import("@/lib/logger")>();
  return { ...mod, proxyLogger: { ...mod.proxyLogger, warn, info: vi.fn(), error: vi.fn() } };
});

const jobs = vi.hoisted(() => ({
  enqueue: vi.fn(async (_k: string, p: { fileId: string }) => ({ status: "new", jobId: `job-${p.fileId}` })),
  runToCompletion: vi.fn(async () => ({})),
}));
vi.mock("@/lib/jobs/manager", () => ({ getJobManager: () => jobs }));
vi.mock("@/lib/jobs/repo", () => ({ findRunningByHash: vi.fn(async () => null) }));

import { audioProxyVerdict, audioProxyReason } from "@/lib/ffmpeg/audio-preview";
import { fileTiming } from "@/lib/ffmpeg/file-timing";
import { getDb } from "@/lib/db/client";
import { sweepAudioPreviewProxies, AUDIO_PREVIEW_SWEEP_MARKER } from "@/lib/proxy/regen-audio-preview";
import { resetRegenOnceForTest } from "@/lib/proxy/regen-once";

describe("HE-AAC check: a failed probe is unknown, not 'no' (review I2)", () => {
  beforeEach(() => {
    ff.mode = "timeout";
    ff.slow = new Set();
    ff.aacCalls = [];
    warn.mockClear();
  });

  it("a timed-out probe answers unknown and logs aac_profile_probe_failed", async () => {
    const v = await audioProxyVerdict("/x/voice.m4a", AAC_AUDIO_ONLY);
    expect(v).toEqual({ reason: null, unknown: true });
    expect(await audioProxyReason("/x/voice.m4a", AAC_AUDIO_ONLY)).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "proxy", op: "aac_profile_probe_failed", file: "voice.m4a", timedOut: true }),
      expect.any(String),
    );
  });

  it("an answered probe is certain", async () => {
    ff.mode = "lc";
    expect(await audioProxyVerdict("/x/voice.m4a", AAC_AUDIO_ONLY)).toEqual({ reason: null, unknown: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it("the timing answer on a timeout is served but not cacheable; an answered one is", async () => {
    const t = await fileTiming("/x/voice.m4a");
    expect(t!.preferProxyAudio).toBe(false);
    expect(t!.cacheable).toBe(false);
    ff.mode = "lc";
    expect((await fileTiming("/x/voice.m4a"))!.cacheable).toBe(true);
  });
});

describe("the audio-preview sweep never writes its marker over an unknown (review I2)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-aac-unknown-"));
    vi.stubEnv("LIBI_HOME", tmp);
    vi.stubEnv("STORAGE_DIR", path.join(tmp, "storage"));
    ff.aacCalls = [];
    jobs.enqueue.mockClear();
    resetRegenOnceForTest();
    const db = createTestDb();
    seedPiece(db, { id: "p1" });
    const dir = path.join(tmp, "storage", "p1");
    fs.mkdirSync(dir, { recursive: true });
    for (const name of ["slow.m4a", "fine.m4a"]) {
      fs.writeFileSync(path.join(dir, name), "x");
      getDb().insert(files).values({ id: name, pieceId: "p1", filename: name, name, description: "", type: "audio", storagePath: `p1/${name}` }).run();
    }
  });
  afterEach(() => {
    resetTestDb();
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("boot 1: one probe times out → no marker, the answered file is recorded; boot 2 judges only the other, then the marker", async () => {
    const marker = path.join(tmp, "state", AUDIO_PREVIEW_SWEEP_MARKER);
    // Boot 1: fine.m4a answers (LC), slow.m4a times out.
    ff.mode = "lc";
    ff.slow = new Set(["slow.m4a"]);
    await sweepAudioPreviewProxies();
    expect(fs.existsSync(marker)).toBe(false);
    expect(jobs.enqueue).not.toHaveBeenCalled();
    const progress = fs.readFileSync(`${marker}.progress`, "utf8").split("\n").filter(Boolean);
    expect(progress).toContain("fine.m4a");
    expect(progress).not.toContain("slow.m4a");

    // Boot 2: the probe answers now; only slow.m4a is probed again.
    resetRegenOnceForTest();
    ff.aacCalls = [];
    ff.slow = new Set();
    await sweepAudioPreviewProxies();
    expect(ff.aacCalls.map((p) => path.basename(p))).toEqual(["slow.m4a"]);
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(`${marker}.progress`)).toBe(false);
  });
});
