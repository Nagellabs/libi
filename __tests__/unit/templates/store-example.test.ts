// __tests__/unit/templates/store-example.test.ts
//
// D4: a template's playable example on the Templates page — written into the
// template folder by `setTemplateExample` (the `template_example` job's last
// step), and what the summary says about it (`mediaRev`, `canRenderExample`,
// `sourcePieceName`), and where each template's render stands.
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { makeScaffold } from "@/__tests__/helpers/templates";
import { getDb } from "@/lib/db/client";
import { jobs, pieces } from "@/lib/db/schema/sqlite";
import { contentFingerprint, readPublishContent } from "@/lib/templates/cloud/publish-content";
import {
  createTemplate,
  EXAMPLE_FAILURE_MAX,
  exampleRenderStatus,
  getTemplateSummary,
  renderingExampleTemplateIds,
  setTemplateExample,
  sourcePieceExists,
  templateDir,
} from "@/lib/templates/store";

let home = "";
let work = "";

async function make(opts: { createdFromPieceId?: string | null; origin?: "local" | "installed" } = {}) {
  const t = await createTemplate({
    name: "Hook + caption",
    description: "Three seconds.",
    tags: ["hook"],
    scaffold: makeScaffold() as never,
    instructions: "# Purpose\nA hook.\n",
    copies: [],
    writes: [],
    createdFromPieceId: opts.createdFromPieceId ?? null,
    ...(opts.origin ? { origin: opts.origin } : {}),
  });
  return t.id;
}
function media(name: string, bytes: string): string {
  const p = path.join(work, name);
  fs.writeFileSync(p, bytes);
  return p;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-store-example-"));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "libi-store-example-work-"));
  process.env.LIBI_HOME = home;
  createTestDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  resetTestDb();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe("setTemplateExample", () => {
  it("writes example.mp4 and poster.jpg into the template folder, replacing an existing pair, and moves mediaRev", async () => {
    const id = await make();
    const before = await getTemplateSummary(id);
    expect(before).toMatchObject({ hasExample: false, hasPoster: false, mediaRev: 0 });

    await setTemplateExample(id, media("a.mp4", "first example"), media("a.jpg", "first poster"));
    const dir = templateDir(id);
    expect(fs.readFileSync(path.join(dir, "example.mp4"), "utf8")).toBe("first example");
    expect(fs.readFileSync(path.join(dir, "poster.jpg"), "utf8")).toBe("first poster");
    const first = await getTemplateSummary(id);
    expect(first).toMatchObject({ hasExample: true, hasPoster: true });
    expect(first!.mediaRev).toBeGreaterThan(0);

    // A later render replaces the pair — and its mtime moves the media URLs' cache key.
    const later = new Date(Date.now() + 5_000);
    await setTemplateExample(id, media("b.mp4", "second example"), media("b.jpg", "second poster"));
    fs.utimesSync(path.join(dir, "example.mp4"), later, later);
    expect(fs.readFileSync(path.join(dir, "example.mp4"), "utf8")).toBe("second example");
    expect((await getTemplateSummary(id))!.mediaRev).toBeGreaterThan(first!.mediaRev);
    // Nothing but the two files is left behind (no temp names).
    expect(fs.readdirSync(dir).filter((n) => n.includes("example") || n.includes("poster")).sort()).toEqual(["example.mp4", "poster.jpg"]);
  });

  it("refuses a template that doesn't exist", async () => {
    await expect(setTemplateExample("no-such-template", media("a.mp4", "x"), media("a.jpg", "y"))).rejects.toThrow(/template_not_found/);
  });

  it("swaps the pair as a pair: a rename that fails half-way puts the old example AND poster back (review M5)", async () => {
    const id = await make();
    const dir = templateDir(id);
    await setTemplateExample(id, media("a.mp4", "old example"), media("a.jpg", "old poster"));
    const real = fsp.rename.bind(fsp);
    // The poster's rename into place fails, after the example's went through.
    vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith(`${path.sep}poster.jpg`) && String(from).endsWith(".new")) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return real(from, to);
    });
    await expect(setTemplateExample(id, media("b.mp4", "new example"), media("b.jpg", "new poster"))).rejects.toThrow(/EBUSY/);
    expect(fs.readFileSync(path.join(dir, "example.mp4"), "utf8")).toBe("old example");
    expect(fs.readFileSync(path.join(dir, "poster.jpg"), "utf8")).toBe("old poster");
    expect(fs.readdirSync(dir).filter((n) => /example|poster/.test(n)).sort()).toEqual(["example.mp4", "poster.jpg"]);
  });

  it("a poster that can't be copied in changes nothing — the old pair stays, no staged file is left", async () => {
    const id = await make();
    const dir = templateDir(id);
    await setTemplateExample(id, media("a.mp4", "old example"), media("a.jpg", "old poster"));
    await expect(setTemplateExample(id, media("b.mp4", "new example"), path.join(work, "missing.jpg"))).rejects.toThrow();
    expect(fs.readFileSync(path.join(dir, "example.mp4"), "utf8")).toBe("old example");
    expect(fs.readdirSync(dir).filter((n) => /example|poster/.test(n)).sort()).toEqual(["example.mp4", "poster.jpg"]);
  });

  it("sweeps what an interrupted swap left behind, and nothing else", async () => {
    const id = await make();
    const dir = templateDir(id);
    fs.writeFileSync(path.join(dir, ".example-0123456789ab.new"), "staged");
    fs.writeFileSync(path.join(dir, ".poster-0123456789ab.old"), "backup");
    fs.writeFileSync(path.join(dir, "notes.example-keep"), "not ours");
    await setTemplateExample(id, media("a.mp4", "example"), media("a.jpg", "poster"));
    expect(fs.readdirSync(dir).filter((n) => /example|poster/.test(n)).sort()).toEqual(["example.mp4", "notes.example-keep", "poster.jpg"]);
  });

  it("does not change what a publish would fingerprint: the folder's own example and poster are not the request's", async () => {
    const id = await make();
    const digest = { example: "e".repeat(64), poster: "p".repeat(64) };
    const before = contentFingerprint(await readPublishContent(id), digest as never);
    await setTemplateExample(id, media("a.mp4", "example"), media("a.jpg", "poster"));
    expect(contentFingerprint(await readPublishContent(id), digest as never)).toBe(before);
  });
});

describe("canRenderExample / sourcePieceName", () => {
  it("a local template names its source piece while it exists; deleting the piece clears both (FK set null), as does none, or installed", async () => {
    const pieceId = seedPiece(getDb() as never, { id: "piece-1", name: "Summer promo" });
    const id = await make({ createdFromPieceId: pieceId });
    expect(await getTemplateSummary(id)).toMatchObject({ canRenderExample: true, sourcePieceName: "Summer promo" });
    // FK actions run (lib/db/schema/sqlite.ts): the delete nulls the lineage id.
    getDb().delete(pieces).where(eq(pieces.id, pieceId)).run();
    expect(await getTemplateSummary(id)).toMatchObject({ canRenderExample: false, sourcePieceName: null });
    expect(await getTemplateSummary(await make())).toMatchObject({ canRenderExample: false, sourcePieceName: null });
    seedPiece(getDb() as never, { id: "piece-2" });
    expect(await getTemplateSummary(await make({ createdFromPieceId: "piece-2", origin: "installed" }))).toMatchObject({ canRenderExample: false, sourcePieceName: null });
  });

  it("sourcePieceExists asks the pieces table for any id — one a job captured before its piece was deleted too", () => {
    seedPiece(getDb() as never, { id: "piece-1" });
    expect(sourcePieceExists("piece-1")).toBe(true);
    getDb().delete(pieces).where(eq(pieces.id, "piece-1")).run();
    expect(sourcePieceExists("piece-1")).toBe(false);
    expect(sourcePieceExists(null)).toBe(false);
  });
});

describe("renderingExampleTemplateIds", () => {
  it("lists the templates with an example render queued or running — nothing finished, nothing of another kind", () => {
    const row = (id: string, kind: string, status: string, templateId: string) =>
      getDb().insert(jobs).values({ id, kind, status: status as never, paramsHash: id, paramsJson: JSON.stringify({ templateId }) }).run();
    row("j1", "template_example", "running", "t-running");
    row("j2", "template_example", "queued", "t-queued");
    row("j3", "template_example", "cancel-requested", "t-stopping");
    row("j4", "template_example", "completed", "t-done");
    row("j5", "template_example", "failed", "t-failed");
    row("j6", "template_publish", "running", "t-publishing");
    expect([...renderingExampleTemplateIds()].sort()).toEqual(["t-queued", "t-running", "t-stopping"]);
  });
});

describe("exampleRenderStatus", () => {
  const at = (sec: number) => new Date(Date.UTC(2026, 8, 25, 0, 0, sec));
  const row = (id: string, status: string, templateId: string, createdAt: Date, error: string | null = null) =>
    getDb().insert(jobs).values({ id, kind: "template_example", status: status as never, paramsHash: id, paramsJson: JSON.stringify({ templateId }), createdAt, error }).run();

  it("names a template whose LAST render failed, with why; not one rendering again, one that later succeeded, or a cancel (review M1)", () => {
    row("a1", "failed", "t-failed", at(1), "the example export failed: Composition cannot be exported: no duration");
    row("b1", "failed", "t-retrying", at(1), "boom");
    row("b2", "running", "t-retrying", at(2));
    row("c1", "failed", "t-recovered", at(1), "boom");
    row("c2", "completed", "t-recovered", at(2));
    row("d1", "cancelled", "t-cancelled", at(1));
    row("e1", "failed", "t-silent", at(1), null);
    row("f1", "failed", "t-long", at(1), `x${"y".repeat(EXAMPLE_FAILURE_MAX * 2)}\nsecond line`);
    const { rendering, failed } = exampleRenderStatus();
    expect([...rendering]).toEqual(["t-retrying"]);
    expect(Object.fromEntries([...failed].filter(([k]) => k !== "t-long"))).toEqual({
      "t-failed": "the example export failed: Composition cannot be exported: no duration",
      "t-silent": "The render failed.",
    });
    expect(failed.get("t-long")).toHaveLength(EXAMPLE_FAILURE_MAX);
    expect(failed.get("t-long")!.endsWith("…")).toBe(true);
  });
});
