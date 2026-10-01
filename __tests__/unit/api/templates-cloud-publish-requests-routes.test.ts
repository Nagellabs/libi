// __tests__/unit/api/templates-cloud-publish-requests-routes.test.ts
//
// "An agent can prepare a publish. Only you can publish." The routes behind the
// Templates page's review panel, against the real store and a real request made
// by the tool: the confirm is the only thing that starts a `template_publish`
// job; it refuses anything but the page's own same-origin request carrying the
// review's confirm code, a template (or its prepared example and poster)
// changed since it was prepared, and a second confirm; discard forgets; the
// request's own example and poster are served to its panel and go with it;
// `POST /api/jobs` starts the kind for nobody.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { makeScaffold } from "@/__tests__/helpers/templates";

const mgr = vi.hoisted(() => ({
  enqueue: vi.fn(),
  runToCompletion: vi.fn(),
  attachToolHint: vi.fn(),
}));
vi.mock("@/lib/jobs/manager", () => ({ getJobManager: () => mgr }));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));
vi.mock("@/mcp/analytics", () => ({ trackMcpEvent: vi.fn() }));
vi.mock("@/lib/templates/cloud/client", () => new Proxy({}, { get: (_t, name) => (name === "then" ? undefined : () => { throw new Error(`called the catalog: ${String(name)}`); }) }));
vi.mock("@/lib/templates/cloud/publish-media", () => import("@/__tests__/helpers/publish-prepare").then((m) => m.fakePublishMedia()));
vi.mock("@/mcp/jobs-client", () => import("@/__tests__/helpers/publish-prepare").then((m) => m.inProcessJobsClient()));
// Publishing is invite-only; these requests are prepared by an approved creator (the gate's own tests: template-cloud-tools.test.ts).
vi.mock("@/lib/templates/cloud/creator", () => ({ checkCreatorApproved: vi.fn(async () => ({ ok: true })) }));

import { GET as LIST } from "@/app/api/templates/cloud/publish-requests/route";
import { DELETE as DISCARD } from "@/app/api/templates/cloud/publish-requests/[id]/route";
import { POST as CONFIRM } from "@/app/api/templates/cloud/publish-requests/[id]/confirm/route";
import { GET as MEDIA } from "@/app/api/templates/cloud/publish-requests/[id]/media/[name]/route";
import { exampleBytesFor, posterBytesFor } from "@/__tests__/helpers/publish-prepare";
import { publishRequestDir, publishRequestsRoot } from "@/lib/templates/cloud/publish-request-media";
import { POST as POST_JOB } from "@/app/api/jobs/route";
import { POST as RETRY_JOB } from "@/app/api/jobs/[id]/retry/route";
import { trackServerEvent } from "@/lib/analytics/server";
import { getDb } from "@/lib/db/client";
import { jobs, templatePublishRequests } from "@/lib/db/schema/sqlite";
import { getOrCreateTemplatesAuthor, setTemplatesAuthorNickname } from "@/lib/db/settings";
import { navigationEmitter } from "@/lib/navigation-events";
import { serverLogger } from "@/lib/logger";
import { createTemplate, deleteTemplate, templateDir } from "@/lib/templates/store";
import type { PublishRequestView } from "@/lib/templates/types";
import { publishTemplate } from "@/mcp/tools/template-cloud-tools";
/** The client module is replaced by a proxy that throws on any call: its one constant is restated here. */
const COMMIT_TIMEOUT_MS = 75_000;

const ORIGIN = "http://127.0.0.1:3461";
const BROWSER = { host: "127.0.0.1:3461", origin: ORIGIN, "sec-fetch-site": "same-origin" };

let home = "";
let src = "";
let templateId = "";
let requestId = "";

function list(headers: Record<string, string> = { host: "127.0.0.1:3461", "sec-fetch-site": "same-origin" }) {
  return LIST(new Request(`${ORIGIN}/api/templates/cloud/publish-requests`, { headers }));
}
async function views(headers?: Record<string, string>): Promise<PublishRequestView[]> {
  return ((await (await list(headers)).json()) as { requests: PublishRequestView[] }).requests;
}
/** The page's confirm: the box ticked (`rightsConfirmed: true`) unless the body says otherwise; `raw` sends the body as given. */
function confirm(id: string, body: unknown, headers: Record<string, string> = BROWSER, raw = false) {
  const sent = !raw && typeof body === "object" && body !== null && !Array.isArray(body) ? { rightsConfirmed: true, ...body } : body;
  return CONFIRM(new Request(`${ORIGIN}/api/templates/cloud/publish-requests/${id}/confirm`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(sent) }), {
    params: Promise.resolve({ id }),
  });
}
function discard(id: string) {
  return DISCARD(new Request(`${ORIGIN}/api/templates/cloud/publish-requests/${id}`, { method: "DELETE", headers: BROWSER }), { params: Promise.resolve({ id }) });
}
async function codeFor(id: string): Promise<string> {
  const v = (await views()).find((r) => r.id === id);
  expect(v?.confirmCode, "the page's own read carries the code").toBeTruthy();
  return v!.confirmCode!;
}
function media(id: string, name: string, headers: Record<string, string> = BROWSER) {
  return MEDIA(new Request(`${ORIGIN}/api/templates/cloud/publish-requests/${id}/media/${name}`, { headers }), { params: Promise.resolve({ id, name }) });
}
const row = (id: string) => getDb().select().from(templatePublishRequests).where(eq(templatePublishRequests.id, id)).get();

/** The job the confirm starts: a real row, run to `outcome` when `finish` is called. */
function jobManagerThatRuns() {
  let finish: (outcome: "completed" | "failed", error?: string) => void = () => {};
  mgr.enqueue.mockImplementation(async (kind: string, params: unknown) => {
    getDb().insert(jobs).values({ id: "job-1", kind, status: "running", paramsJson: JSON.stringify(params), paramsHash: "h" } as never).run();
    return { status: "new", jobId: "job-1", clientKey: "k" };
  });
  mgr.runToCompletion.mockImplementation(
    () =>
      new Promise((resolve, reject) => {
        finish = (outcome, error) => {
          getDb().update(jobs).set({ status: outcome, error: error ?? null }).where(eq(jobs.id, "job-1")).run();
          if (outcome === "completed") resolve({ cloudId: "abcdefghijklmnopqrst", version: 1, exampleBytes: 1 });
          else reject(new Error(error));
        };
      }),
  );
  return { finish: (o: "completed" | "failed", e?: string) => finish(o, e) };
}

beforeEach(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-publish-routes-"));
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
  const r = await publishTemplate({ templateId, exampleVideo: { path: src } });
  requestId = (r as { data: { requestId: string } }).data.requestId;
});
afterEach(() => {
  resetTestDb();
  fs.rmSync(home, { recursive: true, force: true });
  vi.clearAllMocks();
  mgr.enqueue.mockReset();
  mgr.runToCompletion.mockReset();
});

describe("GET the review", () => {
  it("lists the request with what becomes public, the verbatim facts, and nothing started", async () => {
    const [v] = await views();
    expect(v).toMatchObject({
      id: requestId,
      templateId,
      state: "awaiting",
      name: "Hook + caption",
      description: "Three seconds.",
      tags: ["hook", "caption"],
      example: { kind: "path", fileName: "source.mp4" },
      nickname: { value: "nadav", isNew: false },
      republish: false,
      // The catalog it was prepared for, named from the request itself (review M6).
      catalog: { kind: "production", origin: "https://libi.nagellabs.com", host: "libi.nagellabs.com" },
      error: null,
    });
    const labels = v.publicItems.map((i) => i.label);
    expect(labels).toEqual(expect.arrayContaining(["Name, description and tags", "The instructions for the agent (index.md)", "The example video and poster frame shown here", "Your public nickname", "Links to hosted media"]));
    expect(v.publicItems.find((i) => i.label.startsWith("The example video"))?.detail).toMatch(/^Exactly these files, .* made from source\.mp4 on this computer$/);
    expect(mgr.enqueue).not.toHaveBeenCalled();
  });

  it("an identity stored without a nickname shows its default in the review — the name the publish will go out under", async () => {
    setTemplatesAuthorNickname(getOrCreateTemplatesAuthor().key, null);
    const [v] = await views();
    expect(v.nickname.value).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+ [1-9]\d{3}$/);
    expect(v.nickname.isNew).toBe(false);
    expect(v.publicItems.find((i) => i.label === "Your public nickname")?.detail).toBe(v.nickname.value);
    // …and it is stored: the next read, and the publish, use the same one.
    expect((await views())[0].nickname.value).toBe(v.nickname.value);
  });

  it("shows the request's OWN example and poster — served from its folder, exactly the bytes prepared", async () => {
    const [v] = await views();
    expect(v.media).toEqual({
      videoUrl: `/api/templates/cloud/publish-requests/${requestId}/media/example.mp4`,
      posterUrl: `/api/templates/cloud/publish-requests/${requestId}/media/poster.jpg`,
      exampleBytes: exampleBytesFor(Buffer.from("x")).byteLength,
      posterBytes: posterBytesFor(Buffer.from("x")).byteLength,
    });
    const video = await media(requestId, "example.mp4");
    expect(video.status).toBe(200);
    expect(video.headers.get("content-type")).toBe("video/mp4");
    expect(video.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await video.arrayBuffer())).toEqual(exampleBytesFor(Buffer.from("x")));
    const poster = await media(requestId, "poster.jpg");
    expect(poster.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await poster.arrayBuffer())).toEqual(posterBytesFor(Buffer.from("x")));
  });

  it("the media route serves those two files of a real request and nothing else", async () => {
    fs.writeFileSync(path.join(publishRequestDir(requestId), "notes.txt"), "x");
    for (const [id, name] of [
      [requestId, "notes.txt"],
      [requestId, "..%2Fpublish-requests"],
      [requestId, "index.md"],
      ["nope", "example.mp4"],
      ["00000000-0000-4000-8000-000000000000", "example.mp4"],
    ]) {
      expect((await media(id, name)).status, `${id} ${name}`).toBe(404);
    }
    // A planted symlink in place of the example is not followed.
    const example = path.join(publishRequestDir(requestId), "example.mp4");
    fs.rmSync(example);
    fs.symlinkSync(path.join(home, "source.mp4"), example);
    expect((await media(requestId, "example.mp4")).status).toBe(404);
  });

  // Suites W1b: one 404 on a just-prepared request's example.mp4, root cause unknown. The next
  // one must say which of the two checks refused it — never the file's path.
  it("a 404 for a well-formed request's file logs why: no_row or not_file, with tag and op and no path", async () => {
    const warn = vi.spyOn(serverLogger, "warn");
    const reasons = () =>
      warn.mock.calls
        .map(([o]) => o as Record<string, unknown>)
        .filter((o) => o.op === "publish_request_media_not_found");

    // A name the route never serves, and an id that is not a request id, are not W1b: no line.
    expect((await media(requestId, "notes.txt")).status).toBe(404);
    expect((await media("nope", "example.mp4")).status).toBe(404);
    expect(reasons()).toEqual([]);

    const unknown = "00000000-0000-4000-8000-000000000000";
    expect((await media(unknown, "example.mp4")).status).toBe(404);
    fs.rmSync(path.join(publishRequestDir(requestId), "poster.jpg"));
    expect((await media(requestId, "poster.jpg")).status).toBe(404);

    expect(reasons()).toEqual([
      { tag: "templates-cloud", op: "publish_request_media_not_found", requestId: unknown, name: "example.mp4", reason: "no_row" },
      { tag: "templates-cloud", op: "publish_request_media_not_found", requestId, name: "poster.jpg", reason: "not_file" },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(home);
    warn.mockRestore();
  });

  it("another site's guess still 404s, but is never worth a warn line", async () => {
    const warn = vi.spyOn(serverLogger, "warn");
    const unknown = "00000000-0000-4000-8000-000000000000";
    for (const site of ["cross-site", "same-site"]) {
      expect((await media(unknown, "example.mp4", { ...BROWSER, "sec-fetch-site": site })).status).toBe(404);
    }
    expect(warn.mock.calls.map(([o]) => o as Record<string, unknown>).filter((o) => o.op === "publish_request_media_not_found")).toEqual([]);
    warn.mockRestore();
  });

  it("a later change to the SOURCE changes nothing: the review still shows what was prepared, and it can still be published", async () => {
    fs.writeFileSync(src, "the agent's later cut");
    const [v] = await views();
    expect(v).toMatchObject({ state: "awaiting", error: null });
    expect(Buffer.from(await (await media(requestId, "example.mp4")).arrayBuffer())).toEqual(exampleBytesFor(Buffer.from("x")));
  });

  it("a prepared example or poster changed in place makes the request `changed`, with no code to confirm it", async () => {
    for (const name of ["example.mp4", "poster.jpg"]) {
      const file = path.join(publishRequestDir(requestId), name);
      const before = fs.readFileSync(file);
      fs.writeFileSync(file, "swapped after the review");
      const [v] = await views();
      expect(v, name).toMatchObject({ state: "changed", error: "This template changed since it was prepared — ask the agent to prepare it again." });
      expect(v.confirmCode).toBeUndefined();
      fs.writeFileSync(file, before);
      expect((await views())[0].state, name).toBe("awaiting");
    }
    fs.rmSync(path.join(publishRequestDir(requestId), "poster.jpg"));
    const [gone] = await views();
    expect(gone).toMatchObject({ state: "changed", media: null, error: expect.stringMatching(/example video prepared for this publish is gone/) });
  });

  it("sweeps request folders no request owns — never a live one", async () => {
    const orphan = path.join(publishRequestsRoot(), "11111111-1111-4111-8111-111111111111");
    fs.mkdirSync(orphan, { recursive: true });
    fs.writeFileSync(path.join(orphan, "example.mp4"), "left behind");
    await views();
    expect(fs.existsSync(orphan)).toBe(false);
    expect(fs.existsSync(path.join(publishRequestDir(requestId), "example.mp4"))).toBe(true);
  });

  it("hands the confirm code only to the page's own same-origin read — never to a curl, a tool or another site", async () => {
    expect((await views())[0].confirmCode).toMatch(/^[A-Za-z0-9_-]{32}$/);
    for (const headers of [
      {},
      { host: "127.0.0.1:3461" },
      { host: "127.0.0.1:3461", "sec-fetch-site": "none" },
      { host: "127.0.0.1:3461", "sec-fetch-site": "cross-site" },
      // A page DNS-rebound to 127.0.0.1 is "same-origin" to the browser, under its own Host.
      { host: "attacker.example:3461", "sec-fetch-site": "same-origin" },
    ] as Array<Record<string, string>>) {
      const [v] = await views(headers);
      expect(v.confirmCode, JSON.stringify(headers)).toBeUndefined();
      expect(v.id).toBe(requestId);
    }
    expect((await list()).headers.get("cache-control")).toBe("no-store");
  });

  it("shows a template changed since it was prepared as `changed`, with no code to confirm it", async () => {
    fs.writeFileSync(path.join(templateDir(templateId), "index.md"), "# Purpose\nSomething else.\n");
    const [v] = await views();
    expect(v).toMatchObject({ state: "changed", error: "This template changed since it was prepared — ask the agent to prepare it again." });
    expect(v.confirmCode).toBeUndefined();
  });

  it("lists only this catalog's requests: one prepared in test mode stays out of a normal boot, and back in test mode", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    try {
      expect(await views()).toEqual([]);
      expect((await confirm(requestId, { confirmCode: row(requestId)!.confirmCode })).status).toBe(404);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(await views()).toHaveLength(1);
  });
});

describe("POST …/confirm — the only way a publish starts", () => {
  it("starts exactly one template_publish job, in-process, with the reviewed content, and settles the request when it lands", async () => {
    const run = jobManagerThatRuns();
    const refreshed = vi.fn();
    navigationEmitter.on("refresh_query", refreshed);
    try {
      const r = await confirm(requestId, { confirmCode: await codeFor(requestId) });
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, jobId: "job-1" });
      expect(mgr.enqueue).toHaveBeenCalledTimes(1);
      const [kind, params, opts] = mgr.enqueue.mock.calls[0];
      expect(kind).toBe("template_publish");
      expect(params).toEqual({ templateId, requestId, reviewedFingerprint: row(requestId)!.fingerprint });
      expect(opts).toEqual({ forceNew: true });
      expect(mgr.runToCompletion).toHaveBeenCalledWith("job-1");
      expect(trackServerEvent).toHaveBeenCalledWith("template_publish_confirmed");
      expect(row(requestId)).toMatchObject({ status: "publishing", jobId: "job-1" });
      expect((await views())[0]).toMatchObject({ state: "publishing" });
      expect((await views())[0].confirmCode).toBeUndefined();

      run.finish("completed");
      await vi.waitFor(() => expect(row(requestId)).toBeUndefined());
      expect(await views()).toEqual([]);
      // Published: the template holds its own copy now, and the request's folder is gone.
      expect(fs.existsSync(publishRequestDir(requestId))).toBe(false);
      expect(refreshed).toHaveBeenCalledWith({ queryKey: "templates" });
    } finally {
      navigationEmitter.off("refresh_query", refreshed);
    }
  });

  // A-F live check: a commit now waits up to COMMIT_TIMEOUT_MS (75 s), and its replay after that. The panel
  // reads "Publishing…" from the request's state, which holds for as long as the job runs — however long.
  it("stays `publishing` for as long as its job runs, long past a commit's wait, and settles only when the job ends", async () => {
    const run = jobManagerThatRuns();
    await confirm(requestId, { confirmCode: await codeFor(requestId) });
    const longAgo = new Date(Date.now() - COMMIT_TIMEOUT_MS * 4);
    getDb().update(templatePublishRequests).set({ updatedAt: longAgo }).where(eq(templatePublishRequests.id, requestId)).run();
    for (let i = 0; i < 3; i++) expect((await views())[0]).toMatchObject({ state: "publishing" });
    expect(row(requestId)).toMatchObject({ status: "publishing" });
    run.finish("completed");
    await vi.waitFor(() => expect(row(requestId)).toBeUndefined());
  });

  it("passes a nickname prepared with the request to the job", async () => {
    await publishTemplate({ templateId, exampleVideo: { path: src }, nickname: "New Name" });
    const id = (await views())[0].id;
    jobManagerThatRuns();
    expect((await confirm(id, { confirmCode: await codeFor(id) })).status).toBe(200);
    expect(mgr.enqueue.mock.calls[0][1]).toMatchObject({ nickname: "New Name" });
  });

  it("is single-use: the same code a second time starts nothing", async () => {
    jobManagerThatRuns();
    const code = await codeFor(requestId);
    expect((await confirm(requestId, { confirmCode: code })).status).toBe(200);
    const again = await confirm(requestId, { confirmCode: code });
    expect(again.status).toBe(409);
    expect(mgr.enqueue).toHaveBeenCalledTimes(1);
  });

  it("two confirms at once start one job", async () => {
    jobManagerThatRuns();
    const code = await codeFor(requestId);
    const [a, b] = await Promise.all([confirm(requestId, { confirmCode: code }), confirm(requestId, { confirmCode: code })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(mgr.enqueue).toHaveBeenCalledTimes(1);
  });

  it("refuses anything but the page's own same-origin request — and starts nothing", async () => {
    const code = await codeFor(requestId);
    for (const headers of [
      {}, // the agent's shell, a curl
      { host: "127.0.0.1:3461" },
      { ...BROWSER, "sec-fetch-site": "none" },
      { ...BROWSER, "sec-fetch-site": "same-site" },
      { host: "127.0.0.1:3461", "sec-fetch-site": "same-origin" },
      { ...BROWSER, origin: "http://127.0.0.1:9999" },
      { ...BROWSER, origin: "http://localhost:3461" },
      { ...BROWSER, origin: "null" },
    ] as Array<Record<string, string>>) {
      const r = await confirm(requestId, { confirmCode: code }, headers);
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect((await r.json()).code).toBe("browser_only");
    }
    expect(mgr.enqueue).not.toHaveBeenCalled();
    expect(row(requestId)?.status).toBe("awaiting");
  });

  it("refuses a confirm without the rights box ticked (exactly true) — 400 rights_not_confirmed, nothing claimed, no job", async () => {
    const code = await codeFor(requestId);
    for (const body of [{ confirmCode: code }, { confirmCode: code, rightsConfirmed: "true" }, { confirmCode: code, rightsConfirmed: 1 }, { confirmCode: code, rightsConfirmed: false }, null, [code]]) {
      const r = await confirm(requestId, body, BROWSER, true);
      expect(r.status, JSON.stringify(body)).toBe(400);
      expect(await r.json()).toEqual({
        code: "rights_not_confirmed",
        error: "Tick the box to confirm you have the rights to everything in this template, then publish.",
      });
    }
    expect(mgr.enqueue).not.toHaveBeenCalled();
    // Nothing was claimed: the same code still publishes once the box is ticked.
    expect(row(requestId)).toMatchObject({ status: "awaiting", confirmCode: code });
    jobManagerThatRuns();
    expect((await confirm(requestId, { confirmCode: code, rightsConfirmed: true }, BROWSER, true)).status).toBe(200);
    expect(mgr.enqueue).toHaveBeenCalledTimes(1);
  });

  // BC review M6: a local record that the rights were confirmed for this publish — tag and op, ids only.
  it("logs the rights confirmation of a publish that started, with tag and op and no user text; a refused one logs none", async () => {
    const info = vi.spyOn(serverLogger, "info");
    const code = await codeFor(requestId);
    await confirm(requestId, { confirmCode: code, rightsConfirmed: false }, BROWSER, true);
    expect(info.mock.calls.map(([o]) => (o as { op?: string }).op)).not.toContain("publish_rights_confirmed");
    jobManagerThatRuns();
    const r = await confirm(requestId, { confirmCode: code, rightsConfirmed: true }, BROWSER, true);
    const { jobId } = (await r.json()) as { jobId: string };
    const line = info.mock.calls.find(([o]) => (o as { op?: string }).op === "publish_rights_confirmed");
    expect(line?.[0]).toEqual({ tag: "templates-cloud", op: "publish_rights_confirmed", requestId, jobId, rightsConfirmed: true });
    // Never the template's own words (its name, description, the nickname).
    expect(JSON.stringify(line)).not.toMatch(/Hook|hook/);
    info.mockRestore();
  });

  it("the browser-only refusal comes before the rights check", async () => {
    const r = await confirm(requestId, { confirmCode: await codeFor(requestId) }, { host: "127.0.0.1:3461" }, true);
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe("browser_only");
  });

  it("refuses a prepared example swapped since the review, and starts nothing", async () => {
    const code = await codeFor(requestId);
    fs.writeFileSync(path.join(publishRequestDir(requestId), "example.mp4"), "not what the user saw");
    const r = await confirm(requestId, { confirmCode: code });
    expect(r.status).toBe(409);
    expect((await r.json()).code).toBe("changed");
    expect(mgr.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a missing or wrong confirm code — a missing one is not the page's click, a wrong one is out of date", async () => {
    for (const body of [{}, { confirmCode: "" }, { confirmCode: "x".repeat(32) }, { confirmCode: 42 }]) {
      const r = await confirm(requestId, body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      const json = await r.json();
      expect(json.code).toBe("bad_confirm_code");
      expect(json.error, JSON.stringify(body)).toBe(
        typeof body.confirmCode === "string" && body.confirmCode.length > 0
          ? "This review is out of date — it was confirmed somewhere else, such as another tab. Look at it again here, and publish if it's still right."
          : "This confirm didn't come from the review on the Templates page. Open Templates and click Publish there.",
      );
    }
    expect(mgr.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a template changed since it was prepared, in the page's words", async () => {
    const code = await codeFor(requestId);
    fs.writeFileSync(path.join(templateDir(templateId), "index.md"), "# Purpose\nSomething else.\n");
    const r = await confirm(requestId, { confirmCode: code });
    expect(r.status).toBe(409);
    expect(await r.json()).toEqual({ code: "changed", error: "This template changed since it was prepared — ask the agent to prepare it again." });
    expect(mgr.enqueue).not.toHaveBeenCalled();
  });

  it("a publish that fails goes back to the user with the reason, and a fresh confirm tries again", async () => {
    const run = jobManagerThatRuns();
    const first = await codeFor(requestId);
    expect((await confirm(requestId, { confirmCode: first })).status).toBe(200);
    run.finish("failed", "The catalog has taken all the new templates it can today.");
    await vi.waitFor(() => expect(row(requestId)?.status).toBe("failed"));
    // Kept for the retry: the same files.
    expect(fs.existsSync(path.join(publishRequestDir(requestId), "example.mp4"))).toBe(true);
    const [v] = await views();
    expect(v).toMatchObject({ state: "failed", error: "The catalog has taken all the new templates it can today." });
    // The old code is spent — what a second tab still showing the earlier
    // review sends — and it is told so honestly; the panel's new one works.
    const stale = await confirm(requestId, { confirmCode: first });
    expect(stale.status).toBe(403);
    expect(await stale.json()).toMatchObject({
      code: "bad_confirm_code",
      error: "This review is out of date — it was confirmed somewhere else, such as another tab. Look at it again here, and publish if it's still right.",
    });
    expect(row(requestId)?.status).toBe("failed");
    getDb().delete(jobs).run();
    jobManagerThatRuns();
    expect((await confirm(requestId, { confirmCode: v.confirmCode })).status).toBe(200);
  });

  it("a publish cut off by a restart (its job row failed or gone) reads as failed, not publishing forever", async () => {
    jobManagerThatRuns();
    expect((await confirm(requestId, { confirmCode: await codeFor(requestId) })).status).toBe(200);
    getDb().update(jobs).set({ status: "failed", error: "interrupted by restart" }).where(eq(jobs.id, "job-1")).run();
    expect((await views())[0]).toMatchObject({ state: "failed", error: "interrupted by restart" });
  });

  it("404s a request that isn't there", async () => {
    expect((await confirm("nope", { confirmCode: "x" })).status).toBe(404);
  });
});

describe("DELETE — Don't publish", () => {
  it("forgets the request; nothing was started or sent", async () => {
    const r = await discard(requestId);
    expect(r.status).toBe(200);
    expect(row(requestId)).toBeUndefined();
    expect(await views()).toEqual([]);
    expect(trackServerEvent).toHaveBeenCalledWith("template_publish_discarded");
    expect(mgr.enqueue).not.toHaveBeenCalled();
    expect(fs.existsSync(publishRequestDir(requestId))).toBe(false);
    expect((await discard(requestId)).status).toBe(404);
  });

  it("refuses while its publish runs", async () => {
    jobManagerThatRuns();
    await confirm(requestId, { confirmCode: await codeFor(requestId) });
    expect((await discard(requestId)).status).toBe(409);
  });
});

describe("a template's delete takes its requests with it", () => {
  it("cascades, and removes each request's example and poster", async () => {
    expect(row(requestId)).toBeTruthy();
    expect(fs.existsSync(publishRequestDir(requestId))).toBe(true);
    expect(await deleteTemplate(templateId)).toMatchObject({ deleted: true });
    expect(getDb().select().from(templatePublishRequests).all()).toEqual([]);
    expect(fs.existsSync(publishRequestDir(requestId))).toBe(false);
  });
});

describe("the jobs routes never start or re-run a publish", () => {
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    POST_JOB(new Request(`${ORIGIN}/api/jobs`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

  it("POST /api/jobs refuses template_publish from every caller, whatever it carries", async () => {
    const params = { templateId, requestId, reviewedFingerprint: row(requestId)!.fingerprint };
    for (const headers of [{}, BROWSER, { "x-libi-jobs-token": "f".repeat(64) }] as Array<Record<string, string>>) {
      const r = await post({ kind: "template_publish", params, forceNew: true }, headers);
      expect(r.status, JSON.stringify(headers)).toBe(403);
      expect((await r.json()).error).toMatch(/Templates page/);
    }
    expect(mgr.enqueue).not.toHaveBeenCalled();
  });

  it("/api/jobs/:id/retry never re-runs one", async () => {
    getDb().insert(jobs).values({ id: "old", kind: "template_publish", status: "failed", paramsJson: "{}", paramsHash: "h" } as never).run();
    const r = await RETRY_JOB(new Request(`${ORIGIN}/api/jobs/old/retry`, { method: "POST" }), { params: Promise.resolve({ id: "old" }) });
    expect(r.status).toBe(403);
    expect(mgr.enqueue).not.toHaveBeenCalled();
  });
});
