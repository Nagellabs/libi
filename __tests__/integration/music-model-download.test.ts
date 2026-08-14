import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import type { JobContext } from "@/lib/jobs/types";
import type { MusicModelDownloadParams } from "@/lib/jobs/runners/music-model-download";

type Ctx = JobContext<MusicModelDownloadParams>;

/** Hand-built runner context: just the fields musicModelDownloadRunner reads. */
function makeCtx(overrides: Partial<Ctx> = {}): Ctx {
  return {
    params: {},
    reportProgress: vi.fn(),
    shouldCancel: () => false,
    ...overrides,
  } as unknown as Ctx;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-music-dl-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function installModel() {
  const models = await import("@/lib/music/models");
  for (const p of models.aceStepModelFilePaths()) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "x");
  }
  models.writeInstalledToken(models.ACESTEP_MODEL_VERSION);
}

describe("musicModelDownloadRunner", () => {
  it("short-circuits when installed and not forced", async () => {
    await installModel();
    const { musicModelDownloadRunner } = await import(
      "@/lib/jobs/runners/music-model-download"
    );
    const ctx = makeCtx();
    const r = await musicModelDownloadRunner.run(ctx);
    expect(r.alreadyInstalled).toBe(true);
  });

  it("downloads + writes the marker when not installed", async () => {
    const gen = await import("@/lib/music/generate");
    const models = await import("@/lib/music/models");
    const spy = vi.spyOn(gen, "downloadModel").mockImplementation(async () => {
      for (const p of models.aceStepModelFilePaths()) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "x");
      }
    });
    const { musicModelDownloadRunner } = await import(
      "@/lib/jobs/runners/music-model-download"
    );
    const ctx = makeCtx();
    const r = await musicModelDownloadRunner.run(ctx);
    expect(spy).toHaveBeenCalledOnce();
    expect(r.alreadyInstalled).toBe(false);
    expect(models.readInstalledToken()).toBe(models.ACESTEP_MODEL_VERSION);
  });

  it("forwards granular per-file download progress to reportProgress", async () => {
    const gen = await import("@/lib/music/generate");
    const models = await import("@/lib/music/models");
    vi.spyOn(gen, "downloadModel").mockImplementation(
      async (onProgress?: (d: number, t: number) => void) => {
        onProgress?.(3, 12);
        onProgress?.(12, 12);
        for (const p of models.aceStepModelFilePaths()) {
          fs.mkdirSync(path.dirname(p), { recursive: true });
          fs.writeFileSync(p, "x");
        }
      },
    );
    const { musicModelDownloadRunner } = await import(
      "@/lib/jobs/runners/music-model-download"
    );
    const ctx = makeCtx();
    await musicModelDownloadRunner.run(ctx);
    expect(ctx.reportProgress).toHaveBeenCalledWith(3, 12, "files");
    expect(ctx.reportProgress).toHaveBeenCalledWith(12, 12, "files");
  });

  it("ctx.discardOutput clears the dir then re-downloads", async () => {
    // The wipe keys on `discardOutput`, NOT `forced`: every retry surface sets
    // forceNew, so keying on `forced` wiped a resumable pull on every retry.
    await installModel();
    const gen = await import("@/lib/music/generate");
    const models = await import("@/lib/music/models");
    const clearSpy = vi.spyOn(gen, "clearModelDir");
    const dlSpy = vi.spyOn(gen, "downloadModel").mockImplementation(async () => {
      for (const p of models.aceStepModelFilePaths()) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "x");
      }
    });
    const { musicModelDownloadRunner } = await import(
      "@/lib/jobs/runners/music-model-download"
    );
    const ctx = makeCtx({ forced: true, discardOutput: true });
    await musicModelDownloadRunner.run(ctx);
    expect(clearSpy).toHaveBeenCalledOnce();
    expect(dlSpy).toHaveBeenCalledOnce();
  });

  it("a RETRY (forced, but no discard) must NOT clear the dir", async () => {
    // The regression: `forceNew` is set by the failed-row auto-escape in
    // mcp/jobs-client.ts AND by POST /api/jobs/[id]/retry, so a runner keyed
    // on `ctx.forced` discarded a resumable multi-GB pull every time a
    // download was retried after a network blip — and on a user cancel too.
    const gen = await import("@/lib/music/generate");
    const models = await import("@/lib/music/models");
    const clearSpy = vi.spyOn(gen, "clearModelDir");
    vi.spyOn(gen, "downloadModel").mockImplementation(async () => {
      for (const p of models.aceStepModelFilePaths()) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "x");
      }
    });
    const { musicModelDownloadRunner } = await import(
      "@/lib/jobs/runners/music-model-download"
    );
    // Fresh job row (forced) … but no discardOutput: nobody asked to throw
    // the bytes away.
    const ctx = makeCtx({ forced: true });
    await musicModelDownloadRunner.run(ctx);
    expect(
      clearSpy,
      "a retry must resume: huggingface_hub reuses completed files AND " +
        ".incomplete blobs, and both live under the dir this would rm -rf",
    ).not.toHaveBeenCalled();
  });

  it("a NON-forced run never clears the dir (would discard a resumable pull)", async () => {
    const gen = await import("@/lib/music/generate");
    const models = await import("@/lib/music/models");
    const clearSpy = vi.spyOn(gen, "clearModelDir");
    vi.spyOn(gen, "downloadModel").mockImplementation(async () => {
      for (const p of models.aceStepModelFilePaths()) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "x");
      }
    });
    const { musicModelDownloadRunner } = await import(
      "@/lib/jobs/runners/music-model-download"
    );
    const ctx = makeCtx();
    await musicModelDownloadRunner.run(ctx);
    expect(clearSpy).not.toHaveBeenCalled();
  });

  // ── `completed` must mean the weights are on disk ──────────────────────
  //
  // The runner used to write the install token and return success the moment
  // `downloadModel` resolved. But that only means `uv` exited 0 — it is not
  // evidence the snapshot landed. Observed 2026-08-02: a job row reading
  // `completed 12/12` over a directory holding 124 K, because a concurrent
  // forced run had cleared it. The failure then surfaced much later as an
  // opaque MODEL_LOAD_FAILED at generation time.
  it("FAILS instead of reporting success when the weights did not land", async () => {
    const gen = await import("@/lib/music/generate");
    const models = await import("@/lib/music/models");
    // Resolves cleanly, writes nothing — a cleared dir, or a partial snapshot.
    vi.spyOn(gen, "downloadModel").mockResolvedValue();
    const { musicModelDownloadRunner } = await import(
      "@/lib/jobs/runners/music-model-download"
    );
    const ctx = makeCtx();

    await expect(musicModelDownloadRunner.run(ctx)).rejects.toThrow(
      /missing or empty/i,
    );
    expect(
      models.readInstalledToken(),
      "writing the marker here makes isAceStepModelInstalled() lie forever",
    ).toBeNull();
    expect(models.isAceStepModelInstalled()).toBe(false);
  });

  it("names the missing files so the user has something to act on", async () => {
    const gen = await import("@/lib/music/generate");
    const models = await import("@/lib/music/models");
    // Everything but the transformer weights — the realistic partial case.
    vi.spyOn(gen, "downloadModel").mockImplementation(async () => {
      for (const p of models.aceStepModelFilePaths()) {
        if (p.includes("ace_step_transformer")) continue;
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, "x");
      }
    });
    const { musicModelDownloadRunner } = await import(
      "@/lib/jobs/runners/music-model-download"
    );
    const ctx = makeCtx();
    await expect(musicModelDownloadRunner.run(ctx)).rejects.toThrow(
      /ace_step_transformer/,
    );
  });

  it("treats a zero-length file as missing", async () => {
    const gen = await import("@/lib/music/generate");
    const models = await import("@/lib/music/models");
    vi.spyOn(gen, "downloadModel").mockImplementation(async () => {
      for (const p of models.aceStepModelFilePaths()) {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, ""); // truncated / interrupted write
      }
    });
    const { musicModelDownloadRunner } = await import(
      "@/lib/jobs/runners/music-model-download"
    );
    const ctx = makeCtx();
    await expect(musicModelDownloadRunner.run(ctx)).rejects.toThrow(
      /missing or empty/i,
    );
  });

  it("declares one identity: a stray force flag cannot fork the paramsHash", async () => {
    // The schema strips unknown keys, so even a stale caller that still sends
    // `{force:true}` hashes identically to `{}` and attaches to the run in
    // flight rather than starting a competing one.
    const { musicModelDownloadRunner } = await import(
      "@/lib/jobs/runners/music-model-download"
    );
    const { canonicalHash } = await import("@/lib/jobs/canonical-hash");
    const schema = musicModelDownloadRunner.paramsSchema;
    expect(canonicalHash(schema.parse({ force: true }))).toBe(
      canonicalHash(schema.parse({})),
    );
    expect(musicModelDownloadRunner.exclusiveResource).toBe(true);
  });

  it("is registered under kind music_model_download", async () => {
    const { musicModelDownloadRunner } = await import(
      "@/lib/jobs/runners/music-model-download"
    );
    expect(musicModelDownloadRunner.kind).toBe("music_model_download");
    expect(musicModelDownloadRunner.maxConcurrent).toBe(1);
  });
});
