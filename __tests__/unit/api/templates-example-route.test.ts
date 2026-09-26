// __tests__/unit/api/templates-example-route.test.ts
//
// D4: the Templates page's "Render preview" — POST /api/templates/<id>/example
// starts the `template_example` job; GET /api/templates/examples/rendering
// says which templates have one in flight, and which last render failed.
//
// D2–D4 review C1: the route used to insert a queued row that nothing ran.
// These tests drive the REAL JobManager and the real `template_example`
// runner; only the export renderer and ffmpeg are replaced. So a 202 here
// means an example.mp4 lands in the template folder — and (review I1) that
// no `export` row is recorded for the source piece along the way.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { makeScaffold } from "@/__tests__/helpers/templates";

vi.mock("@/lib/templates/cloud/publish-media", () => import("@/__tests__/helpers/publish-prepare").then((m) => m.fakePublishMedia()));
const renderExport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/jobs/runners/export", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/jobs/runners/export")>()), renderExport }));
vi.mock("@/lib/composition/persistence", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/composition/persistence")>();
  return { ...real, loadComposition: vi.fn(async () => ({ manifest: { width: 1080, height: 1920, fps: 30, overlays: [], audioClips: [] } })) };
});

const trackServerEvent = vi.hoisted(() => vi.fn());
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent }));

import { POST } from "@/app/api/templates/[id]/example/route";
import { GET as rendering } from "@/app/api/templates/examples/rendering/route";
import { getDb } from "@/lib/db/client";
import { jobs } from "@/lib/db/schema/sqlite";
import { getJobManager } from "@/lib/jobs/manager";
import { SOURCE_PIECE_GONE } from "@/lib/jobs/runners/template-example";
import type { JobContext } from "@/lib/jobs/types";
import { createTemplate, templateDir } from "@/lib/templates/store";

let home = "";
const post = (id: string) => POST(new Request(`http://127.0.0.1/api/templates/${id}/example`, { method: "POST" }), { params: Promise.resolve({ id }) });
async function make(over: { createdFromPieceId?: string | null; origin?: "local" | "installed" } = {}) {
  return (
    await createTemplate({
      name: "Hook", description: "", tags: [], scaffold: makeScaffold() as never, instructions: "# x\n", copies: [], writes: [],
      createdFromPieceId: over.createdFromPieceId ?? null, ...(over.origin ? { origin: over.origin } : {}),
    })
  ).id;
}
const resetSingletons = () => {
  delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  delete (globalThis as { __libiExportLane?: unknown }).__libiExportLane;
};
/** Resolves when `jobId` has finished, whichever way. */
async function settled(jobId: string): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const row = getDb().select().from(jobs).all().find((j) => j.id === jobId);
    if (row && ["completed", "failed", "cancelled"].includes(row.status)) return row.status;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`job ${jobId} never finished`);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-example-route-"));
  process.env.LIBI_HOME = home;
  createTestDb();
  resetSingletons();
  renderExport.mockReset().mockImplementation(async (c: JobContext<{ destFolder: string }>) => {
    c.reportProgress(50, 100, "%");
    fs.mkdirSync(c.params.destFolder, { recursive: true });
    const out = path.join(c.params.destFolder, "template-example.mp4");
    fs.writeFileSync(out, "rendered piece");
    return { filePath: out };
  });
});
afterEach(() => {
  resetSingletons();
  resetTestDb();
  fs.rmSync(home, { recursive: true, force: true });
});

describe("POST /api/templates/<id>/example", () => {
  it("starts the render and it RUNS: 202 with the job's id, then example.mp4 + poster.jpg in the template folder", async () => {
    const pieceId = seedPiece(getDb() as never, { id: "piece-1" });
    const id = await make({ createdFromPieceId: pieceId });
    const r = await post(id);
    expect(r.status).toBe(202);
    const { jobId } = (await r.json()) as { jobId: string };
    expect(await settled(jobId)).toBe("completed");
    expect(fs.readdirSync(templateDir(id)).filter((n) => /example|poster/.test(n)).sort()).toEqual(["example.mp4", "poster.jpg"]);
    const rows = getDb().select().from(jobs).all();
    // One row: the example job, keyed by the template alone and scoped to no piece (so a piece delete can't cascade it away).
    expect(rows.map((j) => ({ kind: j.kind, pieceId: j.pieceId, params: JSON.parse(j.paramsJson) }))).toEqual([
      { kind: "template_example", pieceId: null, params: { templateId: id } },
    ]);
    // Review I1: no `export` row — nothing may list the render as the source piece's export.
    expect(rows.filter((j) => j.kind === "export")).toEqual([]);
    // Final review F13: asked for, then rendered — no params.
    expect(trackServerEvent).toHaveBeenCalledWith("template_preview_requested");
    expect(trackServerEvent).toHaveBeenCalledWith("template_preview_rendered");
  });

  it("asked again while it renders: attaches to the render in flight, which runs once", async () => {
    const pieceId = seedPiece(getDb() as never, { id: "piece-1" });
    const id = await make({ createdFromPieceId: pieceId });
    let finish: () => void = () => {};
    renderExport.mockImplementationOnce(async (c: JobContext<{ destFolder: string }>) => {
      await new Promise<void>((r) => (finish = r));
      fs.mkdirSync(c.params.destFolder, { recursive: true });
      fs.writeFileSync(path.join(c.params.destFolder, "template-example.mp4"), "x");
      return { filePath: path.join(c.params.destFolder, "template-example.mp4") };
    });
    const first = (await (await post(id)).json()) as { jobId: string };
    await new Promise((r) => setTimeout(r, 30));
    const second = (await (await post(id)).json()) as { jobId: string };
    expect(second.jobId).toBe(first.jobId);
    finish();
    expect(await settled(first.jobId)).toBe("completed");
    expect(renderExport).toHaveBeenCalledTimes(1);
  });

  it("a job that can't be started answers 500 in libi's words, never the thrown message", async () => {
    const pieceId = seedPiece(getDb() as never, { id: "piece-1" });
    const id = await make({ createdFromPieceId: pieceId });
    vi.spyOn(getJobManager(), "enqueue").mockRejectedValueOnce(new Error("No runner registered for kind: template_example"));
    const r = await post(id);
    expect(r.status).toBe(500);
    expect(await r.json()).toEqual({ error: "Couldn't start the preview render. Try again, or restart libi if it keeps failing." });
  });

  it("404 for an unknown or unsafe id", async () => {
    expect((await post("nope")).status).toBe(404);
    expect(await (await post("nope")).json()).toEqual({ error: "template_not_found" });
    expect((await post("../x")).status).toBe(404);
    expect(getDb().select().from(jobs).all()).toEqual([]);
  });

  it("409 source_piece_gone with no source piece, or one that was deleted", async () => {
    const r = await post(await make());
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ error: SOURCE_PIECE_GONE, code: "source_piece_gone" });
    expect(getDb().select().from(jobs).all()).toEqual([]);
  });

  it("409 installed: a catalog template keeps its author's example", async () => {
    const pieceId = seedPiece(getDb() as never, { id: "piece-1" });
    const r = await post(await make({ createdFromPieceId: pieceId, origin: "installed" }));
    expect(r.status).toBe(409);
    expect(await r.json()).toMatchObject({ code: "installed" });
    expect(getDb().select().from(jobs).all()).toEqual([]);
  });
});

describe("GET /api/templates/examples/rendering", () => {
  it("lists in-flight example jobs' template ids, and the templates whose last render failed with why", async () => {
    const row = (id: string, kind: string, status: string, templateId: string, error: string | null = null) =>
      getDb().insert(jobs).values({ id, kind, status: status as never, paramsHash: id, paramsJson: JSON.stringify({ templateId }), error }).run();
    row("j1", "template_example", "running", "t1");
    row("j2", "template_example", "completed", "t2");
    row("j3", "export", "running", "t3");
    row("j4", "template_example", "failed", "t4", "the example export failed: boom");
    row("j5", "export", "failed", "t5", "not an example");
    const r = await rendering();
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ templateIds: ["t1"], failed: [{ templateId: "t4", error: "the example export failed: boom" }] });
  });

  it("a real render that fails shows up there once it has ended", async () => {
    const pieceId = seedPiece(getDb() as never, { id: "piece-1" });
    const id = await make({ createdFromPieceId: pieceId });
    renderExport.mockRejectedValueOnce(new Error("Composition cannot be exported: no duration"));
    const { jobId } = (await (await post(id)).json()) as { jobId: string };
    expect(await settled(jobId)).toBe("failed");
    expect(await (await rendering()).json()).toEqual({
      templateIds: [],
      failed: [{ templateId: id, error: "the example export failed: Composition cannot be exported: no duration" }],
    });
  });
});
