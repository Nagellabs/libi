// __tests__/unit/jobs/template-example-runner.test.ts
//
// D4: the `template_example` job — a playable example for the Templates page,
// made from the template's source piece: export (the shared export path the
// publish prepare uses), transcode to the example caps, poster at 1.0 s, and
// both files written into the template folder. ffmpeg and the export are
// replaced; the store and the export scheduler are real.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { makeScaffold } from "@/__tests__/helpers/templates";

vi.mock("@/lib/templates/cloud/publish-media", () => import("@/__tests__/helpers/publish-prepare").then((m) => m.fakePublishMedia()));
const renderPieceForExample = vi.hoisted(() => vi.fn());
// Default: not empty (undefined is falsy), so existing tests exercise the normal render path.
const pieceHasNothingToExport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/templates/example-export", () => ({ renderPieceForExample, pieceHasNothingToExport }));
// The export job's own slot, as the scheduler's `busy` probe reads it.
const exportJobs = vi.hoisted(() => ({ pending: 0 }));
vi.mock("@/lib/jobs/manager", () => ({ getJobManager: () => ({ activeOrWaiting: (kind: string) => (kind === "export" ? exportJobs.pending : 0) }) }));
const emitted = vi.hoisted(() => vi.fn());
vi.mock("@/lib/navigation-events", () => ({ navigationEmitter: { emit: emitted } }));

import { eq } from "drizzle-orm";
import { getDb } from "@/lib/db/client";
import { pieces } from "@/lib/db/schema/sqlite";
import { BACKGROUND_EXAMPLE_ESTIMATE, getExportScheduler } from "@/lib/export/scheduler";
import { __resetRunnerRegistryForTests, getJobKindToToolIdsMap, getRunner, registerBuiltinRunners } from "@/lib/jobs/runners/registry";
import { SOURCE_PIECE_GONE, templateExampleRunner } from "@/lib/jobs/runners/template-example";
import { CancelledError, type JobContext } from "@/lib/jobs/types";
import { makePoster, transcodeExample } from "@/lib/templates/cloud/publish-media";
import { createTemplate, templateDir } from "@/lib/templates/store";

/** A user's export holding the machine, as the scheduler sees it. Returns its release. */
async function holdUserExport(): Promise<() => void> {
  const r = await getExportScheduler().acquire({ id: `user-${randomUUID()}`, priority: "foreground", estimate: BACKGROUND_EXAMPLE_ESTIMATE });
  return () => r.release();
}

let home = "";
let templateId = "";
let pieceId = "";

type Ctx = JobContext<never> & { progress: number[] };
function ctx(params: unknown, shouldCancel: () => boolean = () => false): Ctx {
  const progress: number[] = [];
  return {
    // Unique per run: the work folder is named by it, in the SHARED tmpdir — another test file's real runner may be using one too.
    jobId: `example-${randomUUID()}`,
    params: templateExampleRunner.paramsSchema.parse(params) as never,
    resumeState: null,
    reportProgress: (d: number) => progress.push(d),
    checkpoint: async () => undefined,
    shouldCancel,
    progress,
  };
}
const folderMedia = () => fs.readdirSync(templateDir(templateId)).filter((n) => /example|poster/.test(n)).sort();

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-template-example-"));
  process.env.LIBI_HOME = home;
  createTestDb();
  pieceId = seedPiece(getDb() as never, { id: "piece-1" });
  const t = await createTemplate({
    name: "Hook + caption",
    description: "Three seconds.",
    tags: ["hook"],
    scaffold: makeScaffold() as never,
    instructions: "# Purpose\nA hook.\n",
    copies: [],
    writes: [],
    createdFromPieceId: pieceId,
  });
  templateId = t.id;
  renderPieceForExample.mockReset().mockImplementation(async (c: JobContext<unknown>, _piece: string, dest: string) => {
    c.reportProgress(30, 100, "%");
    fs.mkdirSync(dest, { recursive: true });
    const out = path.join(dest, "template-example.mp4");
    fs.writeFileSync(out, "rendered piece");
    return out;
  });
  pieceHasNothingToExport.mockReset().mockResolvedValue(false);
  emitted.mockReset();
  exportJobs.pending = 0;
  delete (globalThis as { __libiExportScheduler?: unknown }).__libiExportScheduler;
});
afterEach(() => {
  resetTestDb();
  fs.rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("template_example — registration", () => {
  it("is registered, one at a time, not resumable, keyed by the template alone, and no agent tool drives it", () => {
    __resetRunnerRegistryForTests();
    registerBuiltinRunners();
    expect(getRunner("template_example")).toBe(templateExampleRunner);
    expect(getJobKindToToolIdsMap().get("template_example")).toBeUndefined();
    expect(templateExampleRunner).toMatchObject({ maxConcurrent: 1, resumable: false, exclusiveResource: true, noProgressTimeoutMs: 180_000 });
    const parse = (p: unknown) => templateExampleRunner.paramsSchema.safeParse(p).success;
    expect(parse({ templateId: "t" })).toBe(true);
    expect(parse({ templateId: "" })).toBe(false);
    expect(parse({ templateId: "t", jobId: "x" })).toBe(false);
  });
});

describe("template_example — the render", () => {
  it("exports the source piece, writes example.mp4 + poster.jpg into the template folder, and says so", async () => {
    const c = ctx({ templateId });
    const r = await templateExampleRunner.run(c);
    expect(renderPieceForExample).toHaveBeenCalledWith(expect.objectContaining({ jobId: c.jobId }), pieceId, expect.any(String), expect.any(AbortSignal), expect.any(Number), 60, expect.objectContaining({ reservation: expect.objectContaining({ release: expect.any(Function) }) }));
    expect(folderMedia()).toEqual(["example.mp4", "poster.jpg"]);
    expect(fs.readFileSync(path.join(templateDir(templateId), "example.mp4"), "utf8")).toBe("EXAMPLE:rendered piece");
    expect(fs.readFileSync(path.join(templateDir(templateId), "poster.jpg"), "utf8")).toBe("POSTER:rendered piece");
    expect(r).toEqual({ templateId, exampleBytes: "EXAMPLE:rendered piece".length, posterBytes: "POSTER:rendered piece".length });
    // ffmpeg gets absolute paths only (publish-media refuses anything else).
    for (const call of [...vi.mocked(transcodeExample).mock.calls, ...vi.mocked(makePoster).mock.calls]) {
      expect(path.isAbsolute(call[0])).toBe(true);
      expect(path.isAbsolute(call[1])).toBe(true);
    }
    // Progress only moves forward, and ends at 100.
    expect(c.progress).toEqual([...c.progress].sort((a, b) => a - b));
    expect(c.progress.at(-1)).toBe(100);
    expect(emitted).toHaveBeenCalledWith("refresh_query", { queryKey: "templates" });
  });

  it("a template whose source piece is gone is refused before any work, and nothing is written", async () => {
    const orphan = await createTemplate({
      name: "Orphan", description: "", tags: [], scaffold: makeScaffold() as never, instructions: "# x\n", copies: [], writes: [], createdFromPieceId: null,
    });
    await expect(templateExampleRunner.run(ctx({ templateId: orphan.id }))).rejects.toThrow(SOURCE_PIECE_GONE);
    expect(SOURCE_PIECE_GONE).toBe("This template's source piece is gone, so its preview can't be rendered.");
    expect(renderPieceForExample).not.toHaveBeenCalled();
    expect(fs.readdirSync(templateDir(orphan.id)).filter((n) => /example|poster/.test(n))).toEqual([]);
    await expect(templateExampleRunner.run(ctx({ templateId: "no-such" }))).rejects.toThrow(/template_not_found/);
  });

  it("an installed template keeps its author's example: refused", async () => {
    const installed = await createTemplate({
      name: "Theirs", description: "", tags: [], origin: "installed", scaffold: makeScaffold() as never, instructions: "# x\n", copies: [], writes: [], createdFromPieceId: pieceId,
    });
    await expect(templateExampleRunner.run(ctx({ templateId: installed.id }))).rejects.toThrow(/installed/);
    expect(renderPieceForExample).not.toHaveBeenCalled();
  });

  it("a cancel mid-transcode stops it and leaves no partial files in the folder, nor ITS work folder", async () => {
    let cancelled = false;
    let workSeen = "";
    vi.mocked(transcodeExample).mockImplementationOnce(async (_in: string, out: string, opts?: { signal?: AbortSignal }) => {
      fs.writeFileSync(out, "half an example");
      workSeen = path.dirname(out);
      cancelled = true;
      await new Promise((resolve) => opts?.signal?.addEventListener("abort", resolve, { once: true }));
      throw new Error("ffmpeg killed");
    });
    const c = ctx({ templateId }, () => cancelled);
    await expect(templateExampleRunner.run(c)).rejects.toBeInstanceOf(CancelledError);
    expect(folderMedia()).toEqual([]);
    // This job's own work folder — never a count of the shared tmpdir (fix-round review N3).
    expect(workSeen).toBe(path.join(os.tmpdir(), `libi-template-example-work-${c.jobId}`));
    expect(fs.existsSync(workSeen)).toBe(false);
  });

  it("a failed export fails the job and writes nothing", async () => {
    renderPieceForExample.mockRejectedValueOnce(new Error("the example export failed: boom"));
    await expect(templateExampleRunner.run(ctx({ templateId }))).rejects.toThrow(/boom/);
    expect(folderMedia()).toEqual([]);
    expect(emitted).not.toHaveBeenCalled();
  });

  it("a render that FAILS because its source piece was deleted under it says the piece is gone, not the export's error (final review F9)", async () => {
    renderPieceForExample.mockImplementationOnce(async () => {
      getDb().delete(pieces).where(eq(pieces.id, pieceId)).run();
      throw new Error("the example export failed: ffmpeg exited 1: No such file or directory");
    });
    await expect(templateExampleRunner.run(ctx({ templateId }))).rejects.toThrow(SOURCE_PIECE_GONE);
    expect(folderMedia()).toEqual([]);
  });

  it("a source piece deleted while it renders fails the job with nothing written", async () => {
    renderPieceForExample.mockImplementationOnce(async (_c: JobContext<unknown>, _piece: string, dest: string) => {
      getDb().delete(pieces).where(eq(pieces.id, pieceId)).run();
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "template-example.mp4"), "rendered piece");
      return path.join(dest, "template-example.mp4");
    });
    await expect(templateExampleRunner.run(ctx({ templateId }))).rejects.toThrow(SOURCE_PIECE_GONE);
    expect(folderMedia()).toEqual([]);
  });

  // TPL-3 Important-1: a piece non-empty at template-creation time (so `sourceEmpty` on
  // the card is false, "Render preview" is shown) can be emptied afterwards. The runner
  // must never let that reach renderPieceForExample/the classifier's "nothing to export" —
  // that throws, and JobManager logs any thrown error at error level unconditionally.
  it("a piece with nothing to export completes with no example written, never calling renderPieceForExample", async () => {
    pieceHasNothingToExport.mockResolvedValue(true);
    const c = ctx({ templateId });
    const r = await templateExampleRunner.run(c);
    expect(r).toEqual({ templateId, exampleBytes: 0, posterBytes: 0 });
    expect(renderPieceForExample).not.toHaveBeenCalled();
    expect(folderMedia()).toEqual([]);
    expect(emitted).not.toHaveBeenCalled();
  });

  it("a piece emptied while queued behind a user's export is caught on the re-check, not the classifier", async () => {
    const userExport = await holdUserExport();
    pieceHasNothingToExport.mockResolvedValueOnce(false); // the pre-loop check: still fine
    const run = templateExampleRunner.run(ctx({ templateId }));
    await new Promise((r) => setTimeout(r, 20));
    expect(renderPieceForExample).not.toHaveBeenCalled(); // waiting behind the user's export
    pieceHasNothingToExport.mockResolvedValue(true); // emptied while it waited
    userExport();
    await expect(run).resolves.toEqual({ templateId, exampleBytes: 0, posterBytes: 0 });
    expect(renderPieceForExample).not.toHaveBeenCalled();
    expect(folderMedia()).toEqual([]);
  });
});

describe("template_example — the export scheduler's background priority (D2–D4 review I2)", () => {
  it("waits while a user's export holds the machine or is queued for the export slot, then renders", async () => {
    const userExport = await holdUserExport();
    exportJobs.pending = 1;
    const run = templateExampleRunner.run(ctx({ templateId }));
    await new Promise((r) => setTimeout(r, 40));
    expect(renderPieceForExample).not.toHaveBeenCalled();
    userExport();
    await new Promise((r) => setTimeout(r, 40));
    // Still queued in the export job's slot: not yet.
    expect(renderPieceForExample).not.toHaveBeenCalled();
    exportJobs.pending = 0;
    await run;
    expect(renderPieceForExample).toHaveBeenCalledTimes(1);
    expect(folderMedia()).toEqual(["example.mp4", "poster.jpg"]);
  });

  it("yields to a user's export that arrives mid-render: stops, lets it start, then renders again from the start", async () => {
    const events: string[] = [];
    let attempts = 0;
    let firstStarted: () => void = () => {};
    const firstRunning = new Promise<void>((r) => (firstStarted = r));
    renderPieceForExample.mockImplementation(async (_c: JobContext<unknown>, _piece: string, dest: string, signal: AbortSignal) => {
      attempts++;
      events.push(`render ${attempts} starts`);
      if (attempts === 1) {
        firstStarted();
        await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
        events.push("render 1 stops");
        throw new CancelledError("example-1");
      }
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, "template-example.mp4"), "rendered piece");
      return path.join(dest, "template-example.mp4");
    });
    const c = ctx({ templateId });
    const run = templateExampleRunner.run(c);
    await firstRunning;
    const userExport = await holdUserExport();
    events.push("user export starts");
    await new Promise((r) => setTimeout(r, 40));
    // The render waits for the user's export rather than run beside it.
    expect(attempts).toBe(1);
    events.push("user export done");
    userExport();
    const r = await run;
    expect(events).toEqual(["render 1 starts", "render 1 stops", "user export starts", "user export done", "render 2 starts"]);
    expect(r.templateId).toBe(templateId);
    expect(folderMedia()).toEqual(["example.mp4", "poster.jpg"]);
    expect(c.progress).toEqual([...c.progress].sort((a, b) => a - b));
  });

  it("a cancel while it waits for the scheduler ends it, having rendered nothing", async () => {
    const userExport = await holdUserExport();
    let cancelled = false;
    const run = templateExampleRunner.run(ctx({ templateId }, () => cancelled));
    await new Promise((r) => setTimeout(r, 20));
    cancelled = true;
    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(renderPieceForExample).not.toHaveBeenCalled();
    userExport();
  });
});
