// __tests__/unit/mcp/tools/template-cloud-tools.test.ts
//
// "An agent can prepare a publish. Only you can publish." `libi.publish_template`
// runs the local preflight, then its prepare job makes the request's own example
// and poster and records a publish REQUEST for the user to review on the
// Templates page — it starts no publish and uploads nothing. The prepare
// job runs in-process here (__tests__/helpers/publish-prepare.ts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb, seedPiece } from "@/__tests__/helpers/test-db";
import { makeScaffold } from "@/__tests__/helpers/templates";

// Anything that could reach the catalog fails the test; the only job the tool may run is its prepare.
vi.mock("@/lib/templates/cloud/client", () => new Proxy({}, { get: (_t, name) => (name === "then" ? undefined : () => { throw new Error(`the tool called the catalog: ${String(name)}`); }) }));
vi.mock("@/lib/templates/cloud/publish-media", () => import("@/__tests__/helpers/publish-prepare").then((m) => m.fakePublishMedia()));
vi.mock("@/mcp/jobs-client", () => import("@/__tests__/helpers/publish-prepare").then((m) => m.inProcessJobsClient()));
vi.mock("@/mcp/analytics", () => ({ trackMcpEvent: vi.fn() }));
// Invite-only publishing: the tool asks whether this install may publish before anything else.
const creatorGate = vi.hoisted(() => ({ check: vi.fn() }));
vi.mock("@/lib/templates/cloud/creator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/templates/cloud/creator")>()),
  checkCreatorApproved: creatorGate.check,
}));
// The export renderer (what the `export` job runs) — a piece's example is rendered inside the prepare job, never as an export job.
const renderExport = vi.hoisted(() => vi.fn());
vi.mock("@/lib/jobs/runners/export", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/jobs/runners/export")>()), renderExport }));
// The store, passed through; a test may fail one scaffold read.
vi.mock("@/lib/templates/store", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/templates/store")>();
  return { ...real, readScaffold: vi.fn(real.readScaffold) };
});
vi.mock("@/lib/composition/persistence", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/composition/persistence")>();
  return { ...real, loadComposition: vi.fn(async () => ({ manifest: { width: 1080, height: 1920, fps: 30, overlays: [], audioClips: [] } })) };
});

import { getDb } from "@/lib/db/client";
import { jobs, templatePublishRequests, templates as templatesTable } from "@/lib/db/schema/sqlite";
import { getOrCreateTemplatesAuthor, getTemplatesAuthor, setTemplatesAuthorNickname } from "@/lib/db/settings";
import { createTemplate, readScaffold, templateDir } from "@/lib/templates/store";
import { mcpLogger } from "@/lib/logger";
import { trackMcpEvent } from "@/mcp/analytics";
import { runJobViaServer } from "@/mcp/jobs-client";
import { exampleBytesFor, posterBytesFor, prepareCalls } from "@/__tests__/helpers/publish-prepare";
import { preparingDir, publishRequestDir, publishRequestsRoot } from "@/lib/templates/cloud/publish-request-media";
import { publishTemplateSchema } from "@/mcp/tools/schemas";
import { AWAITING_STATUS, CREATOR_NOT_APPROVED_CODE, nicknameNote, publishTemplate } from "@/mcp/tools/template-cloud-tools";
import { CREATOR_GATE_MESSAGES } from "@/lib/templates/cloud/creator";
import { eq } from "drizzle-orm";

let home = "";
let src = "";
let templateId = "";

async function makeTemplate(patch: Parameters<typeof makeScaffold>[0] = {}) {
  const row = await createTemplate({
    name: "Hook + caption",
    description: "Three seconds.",
    tags: ["hook", "caption"],
    scaffold: makeScaffold({ name: "Hook + caption", description: "Three seconds.", tags: ["hook", "caption"], ...patch }) as never,
    instructions: "# Purpose\nA hook.\n",
    copies: [],
    writes: [],
  });
  return row.id;
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-publish-tool-"));
  process.env.LIBI_HOME = home;
  createTestDb();
  src = path.join(home, "source.mp4");
  fs.writeFileSync(src, "x");
  templateId = await makeTemplate();
  const author = getOrCreateTemplatesAuthor();
  setTemplatesAuthorNickname(author.key, "nadav");
  creatorGate.check.mockResolvedValue({ ok: true });
});
afterEach(() => {
  prepareCalls.length = 0;
  resetTestDb();
  fs.rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
});

const requests = () => getDb().select().from(templatePublishRequests).all();

describe("publishTemplateSchema", () => {
  it("requires exactly one example source and bounds the nickname", () => {
    expect(publishTemplateSchema.safeParse({ templateId: "t", exampleVideo: { fileId: "f" } }).success).toBe(true);
    expect(publishTemplateSchema.safeParse({ templateId: "t", exampleVideo: { exportPieceId: "p" }, nickname: "me" }).success).toBe(true);
    expect(publishTemplateSchema.safeParse({ templateId: "t" }).success).toBe(false);
    expect(publishTemplateSchema.safeParse({ templateId: "t", exampleVideo: { fileId: "f" }, nickname: "x" }).success).toBe(false);
    // Two sources at once is not "exactly one": the second must not be silently dropped.
    expect(publishTemplateSchema.safeParse({ templateId: "t", exampleVideo: { fileId: "f", path: "/tmp/a.mp4" } }).success).toBe(false);
  });

  it("no longer requires confirm — an older skill copy that still sends confirm: true is accepted, and it is described as ignored", () => {
    expect(publishTemplateSchema.safeParse({ templateId: "t", exampleVideo: { fileId: "f" }, confirm: true }).success).toBe(true);
    expect(publishTemplateSchema.safeParse({ templateId: "t", exampleVideo: { fileId: "f" }, confirm: false }).success).toBe(true);
    expect(publishTemplateSchema.shape.confirm.description).toMatch(/Ignored/);
  });
});

describe("publishTemplate — prepares, never publishes", () => {
  it("names the songs the template does not carry, for the agent to tell the user", async () => {
    const id = await makeTemplate({
      audioClips: [{ key: "song", kind: "standalone", startTime: 0, duration: 3, trimStart: 12, volume: 0.8, enabled: true, source: { musicRef: "espresso" } }],
      musicLinks: [{ ref: "espresso", track: { title: "Espresso", artist: "Sabrina Carpenter" }, sourceUrl: "https://www.youtube.com/watch?v=abc" }],
    } as never);
    const r = await publishTemplate({ templateId: id, exampleVideo: { path: src } });
    expect(r.success).toBe(true);
    expect(r.data).toMatchObject({ musicNotIncluded: ["Espresso — Sabrina Carpenter"], musicNote: expect.stringMatching(/not included: tell the user/) });
  });

  it("a scaffold that can't be read back after the prepare: logged, and the publish still answers (no music note)", async () => {
    const warn = vi.spyOn(mcpLogger, "warn");
    const realRun = vi.mocked(runJobViaServer).getMockImplementation()!;
    vi.mocked(runJobViaServer).mockImplementationOnce(async (...args: Parameters<typeof runJobViaServer>) => {
      const out = await realRun(...args);
      // Only the tool's own read AFTER the prepare fails.
      vi.mocked(readScaffold).mockRejectedValueOnce(new Error("EIO: disk gone"));
      return out;
    });
    const r = await publishTemplate({ templateId, exampleVideo: { path: src } });
    expect(r.success).toBe(true);
    expect(r.data).not.toHaveProperty("musicNotIncluded");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "templates", op: "music_links_read_failed", templateId, error: "EIO: disk gone" }), expect.any(String));
  });

  it("makes the request's own example and poster, records one request awaiting the user, and starts no publish", async () => {
    const r = await publishTemplate({ templateId, exampleVideo: { path: src } });
    expect(r).toEqual({
      success: true,
      data: {
        status: AWAITING_STATUS,
        requestId: expect.any(String),
        templateId,
        name: "Hook + caption",
        nickname: "nadav",
        message: "Ready for you to publish. Open Templates in libi and click Publish — I can't publish it for you.",
        nicknameNote: nicknameNote("nadav"),
      },
    });
    // The note names the nickname and every way to change it.
    expect(nicknameNote("nadav")).toMatch(/"nadav"[\s\S]*Publishing as[\s\S]*Settings → General[\s\S]*another nickname/);
    expect(AWAITING_STATUS).toBe("awaiting_your_confirmation");
    const rows = requests();
    expect(rows).toHaveLength(1);
    const id = (r as { data: { requestId: string } }).data.requestId;
    expect(rows[0]).toMatchObject({ id, templateId, status: "awaiting", nickname: null, jobId: null });
    expect(rows[0].fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The confirm code is the review panel's alone: never in what the tool returns.
    expect(JSON.stringify(r)).not.toContain(rows[0].confirmCode);
    // The only job is the prepare, keyed by the template, the example source, the nickname and the catalog it was asked on (review M2) alone.
    expect(vi.mocked(runJobViaServer).mock.calls.map((c) => [c[0], c[1], (c[2] as { forceNew?: boolean }).forceNew])).toEqual([
      ["template_publish_prepare", { templateId, exampleVideo: { path: src }, source: "https://libi.nagellabs.com" }, true],
    ]);
    // The example and poster, made now, in the request's own folder; the preparation folder is gone.
    expect(fs.readFileSync(path.join(publishRequestDir(id), "example.mp4"))).toEqual(exampleBytesFor(Buffer.from("x")));
    expect(fs.readFileSync(path.join(publishRequestDir(id), "poster.jpg"))).toEqual(posterBytesFor(Buffer.from("x")));
    expect(fs.existsSync(preparingDir(id))).toBe(false);
    // No publish job row; the template itself is untouched: no cloud id, no pending publish.
    expect(getDb().select().from(jobs).all()).toHaveLength(0);
    expect(getDb().select().from(templatesTable).where(eq(templatesTable.id, templateId)).get()).toMatchObject({ cloudId: null, publishPending: null });
    expect(trackMcpEvent).toHaveBeenCalledWith("template_publish_requested");
  });

  it("the request holds the source as it was when prepared: changing the source afterwards changes nothing it holds", async () => {
    const r = await publishTemplate({ templateId, exampleVideo: { path: src } });
    const id = (r as { data: { requestId: string } }).data.requestId;
    fs.writeFileSync(src, "the agent's later edit");
    expect(fs.readFileSync(path.join(publishRequestDir(id), "example.mp4"))).toEqual(exampleBytesFor(Buffer.from("x")));
  });

  it("ignores confirm: true — the result is the same request, not a publish", async () => {
    const r = await publishTemplate({ templateId, exampleVideo: { path: src }, confirm: true });
    expect(r).toMatchObject({ success: true, data: { status: AWAITING_STATUS } });
    expect(getDb().select().from(jobs).all()).toHaveLength(0);
  });

  it("keeps a nickname passed with it on the request (applied only when the user publishes)", async () => {
    await publishTemplate({ templateId, exampleVideo: { path: src }, nickname: "  New Name " });
    expect(requests()[0].nickname).toBe("New Name");
  });

  it("a second call replaces the first request and removes its folder: one per template, the newest is what the user reviews", async () => {
    const a = await publishTemplate({ templateId, exampleVideo: { path: src } });
    const b = await publishTemplate({ templateId, exampleVideo: { path: src }, nickname: "other" });
    const rows = requests();
    const aId = (a as { data: { requestId: string } }).data.requestId;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe((b as { data: { requestId: string } }).data.requestId);
    expect(rows[0].id).not.toBe(aId);
    expect(fs.existsSync(publishRequestDir(aId))).toBe(false);
    expect(fs.readdirSync(publishRequestsRoot()).filter((n) => n !== ".preparing")).toEqual([rows[0].id]);
  });

  it("needs no nickname the first time: the first request makes the identity, with a default nickname the result names", async () => {
    getDb().delete((await import("@/lib/db/schema/sqlite")).settings).run();
    expect(getTemplatesAuthor()).toBeNull();
    const r = await publishTemplate({ templateId, exampleVideo: { path: src } });
    const nickname = getTemplatesAuthor()?.nickname;
    expect(nickname).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ [1-9]\d{3}$/);
    expect(r).toMatchObject({ success: true, data: { status: AWAITING_STATUS, nickname, nicknameNote: nicknameNote(nickname!) } });
    // The request itself carries no nickname: the stored one is used, and it is what the review shows.
    expect(requests()[0].nickname).toBeNull();
  });

  it("an identity stored without a nickname is given its default by the first request", async () => {
    setTemplatesAuthorNickname(getTemplatesAuthor()!.key, null);
    const r = await publishTemplate({ templateId, exampleVideo: { path: src } });
    expect((r as { data: { nickname: string } }).data.nickname).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ [1-9]\d{3}$/);
    expect(getTemplatesAuthor()?.nickname).toBe((r as { data: { nickname: string } }).data.nickname);
  });

  it("a nickname passed with it is the one the result names", async () => {
    const r = await publishTemplate({ templateId, exampleVideo: { path: src }, nickname: "eval-bot" });
    expect(r).toMatchObject({ success: true, data: { nickname: "eval-bot" } });
    // Stored only once the user publishes.
    expect(getTemplatesAuthor()?.nickname).toBe("nadav");
  });

  it("runs the catalog's local preflight first: a local video asset is refused with the reason, and nothing is recorded", async () => {
    const bad = await makeTemplate({ assets: [{ ref: "clip", kind: "video", file: "assets/clip.mp4" }] });
    fs.mkdirSync(path.join(templateDir(bad), "assets"), { recursive: true });
    fs.writeFileSync(path.join(templateDir(bad), "assets/clip.mp4"), "x");
    const r = await publishTemplate({ templateId: bad, exampleVideo: { path: src } });
    expect(r).toMatchObject({ success: false, data: { error: expect.stringMatching(/can't be published yet[\s\S]*must be a hosted url/) } });
    expect(requests()).toHaveLength(0);
    expect(runJobViaServer).not.toHaveBeenCalled();
  });

  it("refuses an example that isn't there — a path, a file, a piece", async () => {
    for (const exampleVideo of [{ path: path.join(home, "missing.mp4") }, { fileId: "nope" }, { exportPieceId: "nope" }]) {
      const r = await publishTemplate({ templateId, exampleVideo });
      expect(r, JSON.stringify(exampleVideo)).toMatchObject({ success: false, data: { error: expect.stringMatching(/not found/) } });
    }
    expect(requests()).toHaveLength(0);
  });

  it("exports a piece NOW, with the export renderer and no export job, and the request holds that export", async () => {
    const pieceId = seedPiece(getDb() as never);
    renderExport.mockImplementation(async (c: { params: { pieceId: string } }, target: { dir: string }) => {
      fs.mkdirSync(target.dir, { recursive: true });
      const out = path.join(target.dir, "template-example.mp4");
      fs.writeFileSync(out, "rendered piece");
      return { filePath: out };
    });
    const r = await publishTemplate({ templateId, exampleVideo: { exportPieceId: pieceId } });
    expect(r).toMatchObject({ success: true });
    const id = (r as { data: { requestId: string } }).data.requestId;
    expect(renderExport).toHaveBeenCalledTimes(1);
    expect((renderExport.mock.calls[0][0] as { params: { pieceId: string } }).params.pieceId).toBe(pieceId);
    // No export row: the Posting tab and libi.post_piece must never offer the temporary render as the piece's export.
    expect(getDb().select().from(jobs).all().filter((j) => j.kind === "export")).toEqual([]);
    expect(fs.readFileSync(path.join(publishRequestDir(id), "example.mp4"))).toEqual(exampleBytesFor(Buffer.from("rendered piece")));
    // Only the two files belong to the request: the raw export is gone.
    expect(fs.readdirSync(publishRequestDir(id)).sort()).toEqual(["example.mp4", "poster.jpg"]);
  });

  it("refuses an installed template and an unknown one", async () => {
    getDb().update(templatesTable).set({ origin: "installed" }).where(eq(templatesTable.id, templateId)).run();
    expect(await publishTemplate({ templateId, exampleVideo: { path: src } })).toMatchObject({ success: false, data: { error: expect.stringMatching(/installed from the catalog/) } });
    expect(await publishTemplate({ templateId: "nope", exampleVideo: { path: src } })).toMatchObject({ success: false, data: { error: expect.stringMatching(/not found/) } });
  });

  it("refuses while that template is publishing", async () => {
    getDb().insert(jobs).values({ id: "job-p", kind: "template_publish", status: "running", paramsJson: JSON.stringify({ templateId }), paramsHash: "h" } as never).run();
    expect(await publishTemplate({ templateId, exampleVideo: { path: src } })).toMatchObject({ success: false, data: { error: expect.stringMatching(/publishing right now/) } });
    expect(requests()).toHaveLength(0);
  });

  it("a failed preparation leaves nothing behind: no request, no folder", async () => {
    const media = await import("@/lib/templates/cloud/publish-media");
    vi.mocked(media.makePoster).mockRejectedValueOnce(new Error("poster: the source has no frame at 1 s"));
    const r = await publishTemplate({ templateId, exampleVideo: { path: src } });
    expect(r).toMatchObject({ success: false, data: { error: expect.stringMatching(/no frame/) } });
    expect(requests()).toHaveLength(0);
    const left = fs.existsSync(publishRequestsRoot()) ? fs.readdirSync(publishRequestsRoot()).filter((n) => n !== ".preparing") : [];
    expect(left).toEqual([]);
    const preparing = path.join(publishRequestsRoot(), ".preparing");
    expect(fs.existsSync(preparing) ? fs.readdirSync(preparing) : []).toEqual([]);
  });
});

// Nothing under mcp/ may reach into lib/jobs/* (AGENTS.md): the tool reaches its prepare job through the jobs client only.
describe("publishTemplate — invite-only", () => {
  it("refuses before preparing when the creator isn't approved: libi's words, no request, no job", async () => {
    creatorGate.check.mockResolvedValue({ ok: false, status: "none", error: CREATOR_GATE_MESSAGES.none });
    const out = await publishTemplate({ templateId, exampleVideo: { path: src } });
    // The code is what tells the Templates page to re-read its cached approval (mcp/server.ts).
    expect(out).toEqual({ success: false, data: { error: CREATOR_GATE_MESSAGES.none, code: CREATOR_NOT_APPROVED_CODE } });
    expect(out.success === false && out.data.error).toMatch(/invite-only/);
    expect(runJobViaServer).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(0);
    expect(trackMcpEvent).not.toHaveBeenCalled();
  });
  it("checks the creator before anything else: even a template that doesn't exist hears invite-only", async () => {
    creatorGate.check.mockResolvedValue({ ok: false, status: "pending", error: CREATOR_GATE_MESSAGES.pending });
    expect(await publishTemplate({ templateId: "no-such-template", exampleVideo: { path: src } })).toEqual({
      success: false,
      data: { error: CREATOR_GATE_MESSAGES.pending, code: CREATOR_NOT_APPROVED_CODE },
    });
  });
  it("an unknown status (the catalog didn't answer) also prepares nothing", async () => {
    creatorGate.check.mockResolvedValue({ ok: false, status: "unknown", error: CREATOR_GATE_MESSAGES.unknown });
    const out = await publishTemplate({ templateId, exampleVideo: { path: src } });
    // No code: nothing was learned about the approval, so the page has nothing to re-read (and the site's budget is spent enough).
    expect(out).toEqual({ success: false, data: { error: CREATOR_GATE_MESSAGES.unknown } });
    expect(runJobViaServer).not.toHaveBeenCalled();
    expect(requests()).toHaveLength(0);
  });
  it("an approved creator prepares as before", async () => {
    creatorGate.check.mockResolvedValue({ ok: true });
    const out = await publishTemplate({ templateId, exampleVideo: { path: src } });
    expect(out).toMatchObject({ success: true, data: { status: AWAITING_STATUS } });
    expect(creatorGate.check).toHaveBeenCalledTimes(1);
    expect(requests()).toHaveLength(1);
  });
});

describe("the tool's imports", () => {
  it("imports neither lib/jobs nor the confirm path, and reaches its job through the jobs client", () => {
    const src = fs.readFileSync(path.resolve("mcp/tools/template-cloud-tools.ts"), "utf8");
    expect(src).not.toMatch(/from "@\/lib\/jobs/);
    expect(src).toMatch(/from "@\/mcp\/jobs-client"/);
    expect(src).not.toMatch(/publish-confirm/);
    for (const lib of ["lib/templates/cloud/publish-requests.ts", "lib/templates/cloud/publish-content.ts", "lib/templates/cloud/publish-request-media.ts", "lib/templates/cloud/creator.ts"]) {
      expect(fs.readFileSync(path.resolve(lib), "utf8"), lib).not.toMatch(/from "[^"]*(lib\/jobs|publish-confirm)/);
    }
  });
});
