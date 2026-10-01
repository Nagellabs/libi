// __tests__/unit/jobs/template-publish-prepare-runner.test.ts
//
// The template_publish_prepare job (libi.publish_template's work): the example
// source, resolved NOW into the request's own example and poster, and the
// request recorded — never anything sent. Against the real store and preflight,
// with ffmpeg (publish-media) and the export renderer replaced.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { makeScaffold } from "@/__tests__/helpers/templates";

vi.mock("@/lib/templates/cloud/client", () => new Proxy({}, { get: (_t, name) => (name === "then" ? undefined : () => { throw new Error(`called the catalog: ${String(name)}`); }) }));
vi.mock("@/lib/templates/cloud/publish-media", () => import("@/__tests__/helpers/publish-prepare").then((m) => m.fakePublishMedia()));
// The export renderer itself (what the `export` job runs): the piece's render, minus ffmpeg and Chromium.
const renderExport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/jobs/runners/export", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/jobs/runners/export")>()), renderExport }));
vi.mock("@/lib/composition/persistence", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/composition/persistence")>();
  return { ...real, loadComposition: vi.fn(async () => ({ manifest: { width: 1080, height: 1920, fps: 30, overlays: [], audioClips: [] } })) };
});

import { exampleBytesFor } from "@/__tests__/helpers/publish-prepare";
import { getDb } from "@/lib/db/client";
import { files as filesTable, jobs, pieceExports, pieces, templatePublishRequests } from "@/lib/db/schema/sqlite";
import { generatedStamp } from "@/lib/audio-rights/stamp";
import { serializeAudioRights } from "@/lib/audio-rights/types";
import { serverLogger } from "@/lib/logger";
import { getOrCreateTemplatesAuthor, setTemplatesAuthorNickname } from "@/lib/db/settings";
import { __resetRunnerRegistryForTests, getJobKindToToolIdsMap, getRunner, registerBuiltinRunners } from "@/lib/jobs/runners/registry";
import { templatePublishPrepareRunner } from "@/lib/jobs/runners/template-publish-prepare";
import { CancelledError, type JobContext } from "@/lib/jobs/types";
import { makePoster, transcodeExample } from "@/lib/templates/cloud/publish-media";
import { publishRequestDir, publishRequestsRoot } from "@/lib/templates/cloud/publish-request-media";
import { getStorage } from "@/lib/storage";
import { createTemplate } from "@/lib/templates/store";

let home = "";
let src = "";
let templateId = "";

type Ctx = JobContext<never> & { progress: number[] };
function ctx(params: unknown, shouldCancel: () => boolean = () => false): Ctx {
  const progress: number[] = [];
  return {
    jobId: "prepare-1",
    params: templatePublishPrepareRunner.paramsSchema.parse(params) as never,
    resumeState: null,
    reportProgress: (d: number) => progress.push(d),
    checkpoint: async () => undefined,
    shouldCancel,
    progress,
  };
}
const run = (params: Record<string, unknown>, shouldCancel?: () => boolean) => templatePublishPrepareRunner.run(ctx({ templateId, ...params }, shouldCancel));
const requests = () => getDb().select().from(templatePublishRequests).all();
const leftovers = () => {
  const root = publishRequestsRoot();
  if (!fs.existsSync(root)) return [];
  const preparing = path.join(root, ".preparing");
  return [...fs.readdirSync(root).filter((n) => n !== ".preparing"), ...(fs.existsSync(preparing) ? fs.readdirSync(preparing).map((n) => `.preparing/${n}`) : [])];
};

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-publish-prepare-"));
  process.env.LIBI_HOME = home;
  createTestDb();
  src = path.join(home, "source.mp4");
  fs.writeFileSync(src, "x");
  const t = await createTemplate({
    name: "Hook + caption",
    description: "Three seconds.",
    tags: ["hook", "caption"],
    scaffold: makeScaffold({ name: "Hook + caption", description: "Three seconds.", tags: ["hook", "caption"] }) as never,
    instructions: "# Purpose\nA hook.\n",
    copies: [],
    writes: [],
  });
  templateId = t.id;
  setTemplatesAuthorNickname(getOrCreateTemplatesAuthor().key, "nadav");
});
afterEach(() => {
  resetTestDb();
  fs.rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("template_publish_prepare — registration", () => {
  it("is registered, tied to libi.publish_template, one at a time, keyed by the template, the source and the nickname alone", () => {
    __resetRunnerRegistryForTests();
    registerBuiltinRunners();
    expect(getRunner("template_publish_prepare")).toBe(templatePublishPrepareRunner);
    expect(getJobKindToToolIdsMap().get("template_publish_prepare")).toEqual(["libi:libi.publish_template"]);
    expect(templatePublishPrepareRunner.maxConcurrent).toBe(1);
    expect(templatePublishPrepareRunner.exclusiveResource).toBe(true);
    const parse = (p: unknown) => templatePublishPrepareRunner.paramsSchema.safeParse(p).success;
    expect(parse({ templateId: "t", exampleVideo: { path: "/a.mp4" }, nickname: " nadav " })).toBe(true);
    expect(parse({ templateId: "t", exampleVideo: { path: "/a", fileId: "f" } })).toBe(false);
    expect(parse({ templateId: "t", exampleVideo: { path: "/a" }, requestId: "x" })).toBe(false);
    expect(parse({ templateId: "t", exampleVideo: { path: "/a" }, nickname: "x" })).toBe(false);
  });
});

describe("template_publish_prepare — the example, made now", () => {
  it("a path: transcoded as it is now into the request's own folder, and recorded", async () => {
    const r = await run({ exampleVideo: { path: src } });
    // The nickname the publish goes out under: the stored one, since none was passed.
    expect(r).toEqual({ requestId: expect.any(String), templateId, name: "Hook + caption", nickname: "nadav" });
    expect(vi.mocked(transcodeExample).mock.calls[0][0]).toBe(src);
    expect(vi.mocked(makePoster).mock.calls[0][0]).toBe(src);
    expect(fs.readdirSync(publishRequestDir(r.requestId)).sort()).toEqual(["example.mp4", "poster.jpg"]);
    expect(requests()).toEqual([expect.objectContaining({ id: r.requestId, templateId, status: "awaiting" })]);
    expect(leftovers()).toEqual([r.requestId]);
    // Nothing publishes: no job but this one, and the catalog mock throws on any call.
    expect(getDb().select().from(jobs).all()).toEqual([]);
  });

  it("a piece file: its ORIGINAL (storage.localPath), never its proxy", async () => {
    const db = getDb();
    seedPiece(db as never, { id: "piece-1" });
    db.insert(filesTable).values({ id: "file-1", pieceId: "piece-1", filename: "clip.mov", name: "clip.mov", description: "", type: "video", contentType: "video/quicktime", storagePath: "piece-1/clip.mov", size: 1, proxyFilename: "clip-proxy.mp4" }).run();
    const original = (await getStorage()).localPath("piece-1", "clip.mov");
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(original, "original bytes");
    const r = await run({ exampleVideo: { fileId: "file-1" } });
    expect(vi.mocked(transcodeExample).mock.calls[0][0]).toBe(original);
    expect(fs.readFileSync(path.join(publishRequestDir(r.requestId), "example.mp4"))).toEqual(exampleBytesFor(Buffer.from("original bytes")));
    await expect(run({ exampleVideo: { fileId: "nope" } })).rejects.toThrow(/file not found/);
  });

  it("a piece: rendered by the export renderer with NO export job recorded, its progress forwarded and the watchdog excused only for it", async () => {
    const pieceId = seedPiece(getDb() as never);
    renderExport.mockImplementation(async (c: JobContext<unknown>, target: { dir: string }) => {
      c.reportProgress(50, 100, "%");
      fs.mkdirSync(target.dir, { recursive: true });
      fs.writeFileSync(path.join(target.dir, "template-example.mp4"), "rendered");
      return { filePath: path.join(target.dir, "template-example.mp4") };
    });
    const c = ctx({ templateId, exampleVideo: { exportPieceId: pieceId } });
    let held = 0;
    let maxHeld = 0;
    c.pauseWatchdog = vi.fn(() => {
      held++;
      maxHeld = Math.max(maxHeld, held);
      return () => void held--;
    });
    const r = await templatePublishPrepareRunner.run(c);
    // Paused for the lane wait and the render (nested: fix-round review N2), and every pause released.
    expect(c.pauseWatchdog).toHaveBeenCalled();
    expect(maxHeld).toBeGreaterThan(0);
    expect(held).toBe(0);
    const [renderCtx] = renderExport.mock.calls[0] as [JobContext<Record<string, unknown>>];
    expect(renderCtx.params).toMatchObject({ pieceId, source: "draft", settings: { format: "mp4", codec: "avc", quality: "source" } });
    // D2–D4 review I1: never an `export` row — the Posting tab and libi.post_piece would offer its temporary file as the piece's latest export.
    expect(getDb().select().from(jobs).all().filter((j) => j.kind === "export")).toEqual([]);
    expect(c.progress.some((p) => p > 5 && p < 60)).toBe(true);
    expect(c.progress.at(-1)).toBe(100);
    // Only the two files belong to the request.
    expect(fs.readdirSync(publishRequestDir(r.requestId)).sort()).toEqual(["example.mp4", "poster.jpg"]);
  });

  it("a cancel during the export stops that render; nothing is recorded and nothing is left", async () => {
    const pieceId = seedPiece(getDb() as never);
    let cancelled = false;
    renderExport.mockImplementation(async (c: JobContext<unknown>) => {
      cancelled = true; // the user presses Stop while the export runs
      // The renderer polls shouldCancel and kills its backend.
      expect(c.shouldCancel()).toBe(true);
      throw new Error("ffmpeg killed");
    });
    await expect(run({ exampleVideo: { exportPieceId: pieceId } }, () => cancelled)).rejects.toBeInstanceOf(CancelledError);
    expect(transcodeExample).not.toHaveBeenCalled();
    expect(requests()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it("re-runs the preflight itself: a template that can't be published is refused before any media", async () => {
    await expect(run({ exampleVideo: { path: path.join(home, "missing.mp4") }, nickname: "nadav" })).rejects.toThrow(/example video not found/);
    expect(transcodeExample).not.toHaveBeenCalled();
    expect(leftovers()).toEqual([]);
  });

  it("a failed transcode leaves nothing: no request, no folder", async () => {
    vi.mocked(transcodeExample).mockRejectedValueOnce(new Error("example video is over 8 MB even at CRF 32"));
    await expect(run({ exampleVideo: { path: src } })).rejects.toThrow(/over 8 MB/);
    expect(requests()).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  it("a newer preparation replaces an awaiting one and removes its folder", async () => {
    const a = await run({ exampleVideo: { path: src } });
    fs.writeFileSync(src, "a newer cut");
    const b = await run({ exampleVideo: { path: src } });
    expect(requests().map((r) => r.id)).toEqual([b.requestId]);
    expect(leftovers()).toEqual([b.requestId]);
    expect(fs.existsSync(publishRequestDir(a.requestId))).toBe(false);
    expect(fs.readFileSync(path.join(publishRequestDir(b.requestId), "example.mp4"))).toEqual(exampleBytesFor(Buffer.from("a newer cut")));
  });
});

// Social-music review (Task 20): a template example is public, so a copyrighted
// song never reaches it — whatever the example's source is.
describe("template_publish_prepare — the example never carries a copyrighted song", () => {
  const songRights = serializeAudioRights({ class: "copyrighted", track: { title: "Espresso", artist: "Sabrina Carpenter" }, decidedBy: "agent", decidedAt: "2026-09-27T00:00:00Z" });
  async function seedVideoFile(id: string, audioRights: string | null, description = ""): Promise<string> {
    const db = getDb();
    if (!db.select().from(pieces).all().some((p) => p.id === "piece-1")) seedPiece(db as never, { id: "piece-1" });
    db.insert(filesTable).values({ id, pieceId: "piece-1", filename: `${id}.mp4`, name: `${id}.mp4`, description, type: "video", contentType: "video/mp4", storagePath: `piece-1/${id}.mp4`, size: 1, audioRights }).run();
    const original = (await getStorage()).localPath("piece-1", `${id}.mp4`);
    fs.mkdirSync(path.dirname(original), { recursive: true });
    fs.writeFileSync(original, "original bytes");
    return original;
  }
  /** An export file where exports live — `<storage>/piece-1/exports/<name>`. */
  async function exportFile(name = "source.mp4"): Promise<string> {
    const db = getDb();
    if (!db.select().from(pieces).all().some((p) => p.id === "piece-1")) seedPiece(db as never, { id: "piece-1" });
    const abs = (await getStorage()).localPath("piece-1", `exports/${name}`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, "x");
    return abs;
  }
  /** Its finished export record, as the export job leaves it. */
  function recordExport(filePath: string, carriesCopyrighted: boolean, completedAt = new Date()): void {
    getDb().insert(pieceExports).values({
      id: `exp_${Math.random().toString(36).slice(2)}`,
      pieceId: "piece-1",
      name: path.basename(filePath, ".mp4"),
      relPath: `exports/${path.basename(filePath)}`,
      status: "done",
      queuedAt: completedAt,
      completedAt,
      aspect: "9:16",
      container: "mp4",
      codec: "avc",
      fps: 30,
      source: "agent",
      purpose: carriesCopyrighted ? "personal" : "social",
      carriesCopyrighted,
      excludedFileIds: JSON.stringify(carriesCopyrighted ? [] : ["song"]),
    }).run();
  }
  const transcodeOpts = () => vi.mocked(transcodeExample).mock.calls[0][2] as { dropAudio?: boolean };
  const dropLogs = () => vi.mocked(serverLogger.info).mock.calls.filter(([o]) => (o as { op?: string }).op === "template_example_audio_dropped");

  beforeEach(() => {
    vi.spyOn(serverLogger, "info");
  });

  it("a piece file whose audio is copyrighted: transcoded WITHOUT its audio, and the decision logged by file id", async () => {
    await seedVideoFile("song-video", songRights);
    await run({ exampleVideo: { fileId: "song-video" } });
    expect(transcodeOpts().dropAudio).toBe(true);
    expect(dropLogs()).toEqual([[expect.objectContaining({ tag: "social-music", op: "template_example_audio_dropped", fileId: "song-video" }), expect.any(String)]]);
  });

  // Owner decision 2026-09-28: an unstamped file is the user's own upload.
  it("an unstamped piece file is the user's own: it keeps its audio", async () => {
    await seedVideoFile("upload", null);
    await run({ exampleVideo: { fileId: "upload" } });
    expect(transcodeOpts().dropAudio).toBe(false);
    expect(dropLogs()).toEqual([]);
  });

  it("an unstamped legacy download (\"Downloaded from <url>\") reads as copyrighted: its audio is dropped", async () => {
    await seedVideoFile("legacy-dl", null, "Downloaded from https://youtu.be/x");
    await run({ exampleVideo: { fileId: "legacy-dl" } });
    expect(transcodeOpts().dropAudio).toBe(true);
  });

  it("a generated piece file keeps its audio", async () => {
    await seedVideoFile("gen", serializeAudioRights(generatedStamp("lofi beat", new Date("2026-09-27T00:00:00Z"))));
    await run({ exampleVideo: { fileId: "gen" } });
    expect(transcodeOpts().dropAudio).toBe(false);
    expect(dropLogs()).toEqual([]);
  });

  it("a path that is a with-song export: its audio is dropped, and only the basename is logged", async () => {
    const file = await exportFile();
    recordExport(file, true);
    await run({ exampleVideo: { path: file } });
    expect(transcodeOpts().dropAudio).toBe(true);
    const [[logged]] = dropLogs();
    expect(logged).toMatchObject({ tag: "social-music", op: "template_example_audio_dropped", path: "source.mp4" });
    expect(JSON.stringify(logged)).not.toContain(home);
  });

  it("a path that is a without-song export keeps its audio", async () => {
    const file = await exportFile();
    recordExport(file, false);
    await run({ exampleVideo: { path: file } });
    expect(transcodeOpts().dropAudio).toBe(false);
  });

  it("the NEWEST export to that path decides: a with-song re-export over a without-song one drops the audio", async () => {
    const file = await exportFile();
    recordExport(file, false, new Date("2026-09-27T10:00:00Z"));
    recordExport(file, true, new Date("2026-09-27T11:00:00Z"));
    await run({ exampleVideo: { path: file } });
    expect(transcodeOpts().dropAudio).toBe(true);
  });

  it("a path libi never exported — even one in a piece's exports folder: its audio is dropped", async () => {
    await run({ exampleVideo: { path: src } });
    expect(transcodeOpts().dropAudio).toBe(true);
    vi.mocked(transcodeExample).mockClear();
    const unrecorded = await exportFile("unrecorded.mp4");
    await run({ exampleVideo: { path: unrecorded } });
    expect(transcodeOpts().dropAudio).toBe(true);
  });

  it("an exported piece keeps its audio: the example export is a social one, which already leaves the song out", async () => {
    const pieceId = seedPiece(getDb() as never);
    renderExport.mockImplementation(async (c: JobContext<unknown>, target: { dir: string }) => {
      fs.mkdirSync(target.dir, { recursive: true });
      fs.writeFileSync(path.join(target.dir, "template-example.mp4"), "rendered");
      return { filePath: path.join(target.dir, "template-example.mp4") };
    });
    await run({ exampleVideo: { exportPieceId: pieceId } });
    expect(transcodeOpts().dropAudio).toBe(false);
    expect((renderExport.mock.calls[0][0] as JobContext<{ settings: { purpose?: string } }>).params.settings.purpose).toBe("social");
  });
});
