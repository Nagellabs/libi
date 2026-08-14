import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FileRecord } from "@/lib/db/schema/types";
import fs from "fs";
import os from "os";
import path from "path";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-music-t-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("musicListStyles", () => {
  it("returns styles + modelInstalled + size", async () => {
    const { musicListStyles } = await import("@/mcp/tools/music-tools");
    const r = await musicListStyles({});
    expect(r.success).toBe(true);
    expect(r.data?.modelInstalled).toBe(false);
    expect(r.data?.downloadSizeHuman).toMatch(/GB/);
    expect(Array.isArray(r.data?.styles)).toBe(true);
  });
});

describe("generateMusic tool", () => {
  it("returns needs_install (with size) when the model is absent (no job)", async () => {
    const { generateMusic } = await import("@/mcp/tools/music-tools");
    const r = await generateMusic({ prompt: "calm lofi" });
    expect(r.success).toBe(false);
    expect(r.data?.status).toBe("needs_install");
    expect(r.data?.downloadSizeHuman).toMatch(/GB/);
    expect(r.data?.hint).toMatch(/get_install_plan/);
  });

  it("returns confirm_duration when estimate is long and confirm not set", async () => {
    const { generateMusic } = await import("@/mcp/tools/music-tools");
    const fakeGen = async () => ({
      wavPath: "x",
      sampleRate: 48000,
      durationSeconds: 240,
      channels: 2,
      instrumental: true,
      seed: 0,
    });
    const r = await generateMusic(
      { prompt: "epic", durationSeconds: 240 },
      undefined,
      fakeGen,
    );
    expect(r.success).toBe(false);
    expect(r.data?.status).toBe("confirm_duration");
    expect(r.data?.estimatedSeconds).toBeGreaterThan(0);
  });

  it("generates via injected genFn and stores the file", async () => {
    const fileTools = await import("@/mcp/tools/file-tools");
    const fakeRecord = { id: "f1", filename: "music.wav" };
    const storeSpy = vi
      .spyOn(fileTools, "storeFile")
      .mockResolvedValue(fakeRecord as FileRecord);
    const wav = path.join(tmp, "out.wav");
    fs.writeFileSync(wav, Buffer.from("RIFFWAVE"));
    const { generateMusic } = await import("@/mcp/tools/music-tools");
    const r = await generateMusic(
      { prompt: "calm lofi piano", durationSeconds: 8, confirm: true, pieceId: "p1" },
      undefined,
      async () => ({
        wavPath: wav,
        sampleRate: 48000,
        durationSeconds: 8,
        channels: 2,
        instrumental: true,
        seed: 3,
      }),
    );
    expect(r.success).toBe(true);
    expect(r.data?.file).toEqual(fakeRecord);
    expect(r.data?.durationSeconds).toBe(8);
    expect(storeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ pieceId: "p1", contentType: "audio/wav", hasAudio: true }),
    );
    expect(fs.existsSync(wav)).toBe(false);
  });

  it("maps a MODEL_LOAD_FAILED job error to model_load_failed", async () => {
    const wav = path.join(tmp, "x.wav");
    const { generateMusic } = await import("@/mcp/tools/music-tools");
    const r = await generateMusic(
      { prompt: "calm", durationSeconds: 8, confirm: true },
      undefined,
      async () => {
        throw new Error("MODEL_LOAD_FAILED: corrupt safetensors");
      },
    );
    void wav;
    expect(r.success).toBe(false);
    expect(r.data?.status).toBe("model_load_failed");
    expect(r.data?.hint).toMatch(/force: true/);
  });

  it("returns insufficient_memory when free RAM is below the threshold (real path)", async () => {
    // Make the model appear installed so the install gate doesn't short-circuit.
    const models = await import("@/lib/music/models");
    vi.spyOn(models, "isAceStepModelInstalled").mockReturnValue(true);
    // Env-signature gate is the second half of needs_install — pre-write
    // the token so this test focuses only on the memory branch.
    const gen = await import("@/lib/music/generate");
    gen.writeAceStepEnvToken();

    // Pretend the host has only 2 GB available (free + reclaimable cache).
    // We spy on the cross-platform helper so the test works the same on
    // darwin (which reads vm_stat) and linux (which uses os.freemem).
    const TWO_GB = 2 * 1024 * 1024 * 1024;
    const SIXTEEN_GB = 16 * 1024 * 1024 * 1024;
    const availMem = await import("@/lib/system/available-memory");
    vi.spyOn(availMem, "getAvailableMemoryBytes").mockReturnValue(TWO_GB);
    vi.spyOn(os, "totalmem").mockReturnValue(SIXTEEN_GB);

    const { generateMusic } = await import("@/mcp/tools/music-tools");
    const r = await generateMusic({
      prompt: "calm lofi",
      durationSeconds: 8,
      confirm: true,
    });
    expect(r.success).toBe(false);
    expect(r.data?.status).toBe("insufficient_memory");
    expect(r.data?.freeBytes).toBe(TWO_GB);
    expect(r.data?.totalBytes).toBe(SIXTEEN_GB);
    expect(r.data?.requiredBytes).toBeGreaterThan(TWO_GB);
    expect(r.data?.hint).toMatch(/14 GB.*free|free.*14 GB/);
  });

  it("after a real download lands on disk, musicListStyles().modelInstalled flips to true", async () => {
    // Regression: previously ACESTEP_FILES had `music_dcae/` but the HF repo
    // actually publishes `music_dcae_f8c8/`, so detection was always false
    // even when 7.7 GB of weights sat happily on disk. This asserts the
    // manifest paths match what `snapshot_download(local_dir=…)` writes.
    const {
      aceStepModelsDir,
      ACESTEP_FILES,
      ACESTEP_MODEL_VERSION,
      writeInstalledToken,
    } = await import("@/lib/music/models");
    const dir = aceStepModelsDir();
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ACESTEP_FILES) {
      const full = path.join(dir, f.relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      // Tiny placeholder — detection only stat()s, doesn't read contents.
      fs.writeFileSync(full, "x");
    }
    writeInstalledToken(ACESTEP_MODEL_VERSION);

    const { musicListStyles } = await import("@/mcp/tools/music-tools");
    const r = await musicListStyles({});
    expect(r.success).toBe(true);
    expect(r.data?.modelInstalled).toBe(true);
  });

  it("memory check is BYPASSED when genFn is provided (test seam)", async () => {
    // Even with low free memory, an injected genFn (test/BYO path) should
    // skip the pre-flight RAM check so unit tests don't depend on host RAM.
    vi.spyOn(os, "freemem").mockReturnValue(100 * 1024 * 1024); // 100 MB
    const fileTools = await import("@/mcp/tools/file-tools");
    const fakeRecord = { id: "f-mem", filename: "x.wav" };
    vi.spyOn(fileTools, "storeFile").mockResolvedValue(fakeRecord as FileRecord);
    const wav = path.join(tmp, "ram-bypass.wav");
    fs.writeFileSync(wav, Buffer.from("RIFFWAVE"));
    const { generateMusic } = await import("@/mcp/tools/music-tools");
    const r = await generateMusic(
      { prompt: "ok", durationSeconds: 8, confirm: true, pieceId: "p1" },
      undefined,
      async () => ({
        wavPath: wav,
        sampleRate: 48000,
        durationSeconds: 8,
        channels: 2,
        instrumental: true,
        seed: 0,
      }),
    );
    expect(r.success).toBe(true);
  });
});
// --- 4-shape RunJobResult contract (T16) -----------------------------------
// These tests cover the real-path (no genFn) branch — runJobViaServer is
// mocked so we can drive each of the four possible response shapes and
// assert how each is surfaced to the agent. The previous tests use the
// genFn seam and never reach the runJobViaServer call site.

describe("generateMusic RunJobResult shapes", () => {
  beforeEach(async () => {
    // Make the install gate + RAM check + env-token unconditional pass so
    // the real-path branch is reached.
    const models = await import("@/lib/music/models");
    vi.spyOn(models, "isAceStepModelInstalled").mockReturnValue(true);
    const gen = await import("@/lib/music/generate");
    gen.writeAceStepEnvToken();
    const availMem = await import("@/lib/system/available-memory");
    const SIXTEEN_GB = 16 * 1024 * 1024 * 1024;
    vi.spyOn(availMem, "getAvailableMemoryBytes").mockReturnValue(SIXTEEN_GB);
  });

  it("status:'new' surfaces jobId + clientKey, no dedup markers", async () => {
    const wav = path.join(tmp, "new.wav");
    fs.writeFileSync(wav, Buffer.from("RIFFWAVE"));
    const fileTools = await import("@/mcp/tools/file-tools");
    vi.spyOn(fileTools, "storeFile").mockResolvedValue({
      id: "f-new",
      filename: "music.wav",
    } as FileRecord);
    const client = await import("@/mcp/jobs-client");
    const runSpy = vi.spyOn(client, "runJobViaServer").mockResolvedValue({
      status: "new",
      jobId: "job-new",
      clientKey: "ck-new",
      result: {
        wavPath: wav,
        sampleRate: 48000,
        durationSeconds: 8,
        channels: 2,
        instrumental: true,
        seed: 1,
      },
    });

    const { generateMusic } = await import("@/mcp/tools/music-tools");
    const r = await generateMusic({
      prompt: "fresh lofi",
      durationSeconds: 8,
      confirm: true,
      pieceId: "p1",
    });
    expect(r.success).toBe(true);
    const d = r.data ?? {};
    expect(d.jobId).toBe("job-new");
    expect(d.clientKey).toBe("ck-new");
    expect(d.attachedToRunning).toBeUndefined();
    expect(d.matchedExisting).toBeUndefined();
    expect(d.file).toEqual({ id: "f-new", filename: "music.wav" });
    expect(d.durationSeconds).toBe(8);
    // forceNew flows through unchanged when omitted (defaults to false).
    expect(runSpy.mock.calls[0]?.[2]).toMatchObject({
      pieceId: "p1",
      forceNew: false,
    });
  });

  it("status:'new' with forced:true marks data.forced and passes forceNew through", async () => {
    const wav = path.join(tmp, "forced.wav");
    fs.writeFileSync(wav, Buffer.from("RIFFWAVE"));
    const fileTools = await import("@/mcp/tools/file-tools");
    vi.spyOn(fileTools, "storeFile").mockResolvedValue({ id: "f-f" } as FileRecord);
    const client = await import("@/mcp/jobs-client");
    const runSpy = vi.spyOn(client, "runJobViaServer").mockResolvedValue({
      status: "new",
      jobId: "job-forced",
      clientKey: "ck-forced",
      forced: true,
      result: {
        wavPath: wav,
        sampleRate: 48000,
        durationSeconds: 8,
        channels: 2,
        instrumental: true,
        seed: 2,
      },
    });

    const { generateMusic } = await import("@/mcp/tools/music-tools");
    const r = await generateMusic({
      prompt: "fresh forced lofi",
      durationSeconds: 8,
      confirm: true,
      pieceId: "p1",
      forceNew: true,
    });
    expect(r.success).toBe(true);
    const d = r.data ?? {};
    expect(d.jobId).toBe("job-forced");
    expect(d.forced).toBe(true);
    expect(d.attachedToRunning).toBeUndefined();
    expect(d.matchedExisting).toBeUndefined();
    expect(runSpy.mock.calls[0]?.[2]).toMatchObject({ forceNew: true });
  });

  it("status:'attached_running' surfaces attachedToRunning + existingJob + still stores file", async () => {
    const wav = path.join(tmp, "attached.wav");
    fs.writeFileSync(wav, Buffer.from("RIFFWAVE"));
    const fileTools = await import("@/mcp/tools/file-tools");
    vi.spyOn(fileTools, "storeFile").mockResolvedValue({
      id: "f-att",
      filename: "music.wav",
    } as FileRecord);
    const client = await import("@/mcp/jobs-client");
    vi.spyOn(client, "runJobViaServer").mockResolvedValue({
      status: "attached_running",
      jobId: "job-att",
      clientKey: "ck-att",
      existingJob: {
        jobId: "job-orig",
        pieceId: "p1",
        startedAt: "2026-05-21T10:00:00Z",
      },
      result: {
        wavPath: wav,
        sampleRate: 48000,
        durationSeconds: 8,
        channels: 2,
        instrumental: true,
        seed: 3,
      },
    });

    const { generateMusic } = await import("@/mcp/tools/music-tools");
    const r = await generateMusic({
      prompt: "attached lofi",
      durationSeconds: 8,
      confirm: true,
      pieceId: "p1",
    });
    expect(r.success).toBe(true);
    const d = r.data ?? {};
    expect(d.attachedToRunning).toBe(true);
    expect(d.matchedExisting).toBeUndefined();
    expect(d.existingJob).toEqual({
      jobId: "job-orig",
      pieceId: "p1",
      startedAt: "2026-05-21T10:00:00Z",
    });
    expect(d.jobId).toBe("job-att");
    expect(d.clientKey).toBe("ck-att");
    expect(d.file).toEqual({ id: "f-att", filename: "music.wav" });
  });

  it("status:'matching_completed' surfaces matchedExisting + existingJob and does NOT store a new file", async () => {
    const fileTools = await import("@/mcp/tools/file-tools");
    const storeSpy = vi
      .spyOn(fileTools, "storeFile")
      .mockResolvedValue({ id: "f-should-not-happen" } as FileRecord);
    const client = await import("@/mcp/jobs-client");
    vi.spyOn(client, "runJobViaServer").mockResolvedValue({
      status: "matching_completed",
      existingJob: {
        jobId: "job-cached",
        pieceId: "p1",
        completedAt: "2026-05-20T12:00:00Z",
        status: "completed",
        result: {
          wavPath: "/tmp/long-gone.wav",
          sampleRate: 48000,
          durationSeconds: 30,
          channels: 2,
          instrumental: false,
          seed: 7,
        },
      },
    });

    const { generateMusic } = await import("@/mcp/tools/music-tools");
    const r = await generateMusic({
      prompt: "cached lofi",
      durationSeconds: 30,
      confirm: true,
      pieceId: "p1",
    });
    expect(r.success).toBe(true);
    const d = r.data ?? {};
    expect(d.matchedExisting).toBe(true);
    expect(d.attachedToRunning).toBeUndefined();
    expect(d.existingJob).toEqual({
      jobId: "job-cached",
      pieceId: "p1",
      completedAt: "2026-05-20T12:00:00Z",
      status: "completed",
      result: expect.objectContaining({ durationSeconds: 30 }),
    });
    // Cached metadata is spread into data so the agent has context.
    expect(d.durationSeconds).toBe(30);
    expect(d.channels).toBe(2);
    expect(d.seed).toBe(7);
    // We must NOT have tried to read the long-gone wav file or store it.
    expect(storeSpy).not.toHaveBeenCalled();
    expect(d.file).toBeUndefined();
  });
});
