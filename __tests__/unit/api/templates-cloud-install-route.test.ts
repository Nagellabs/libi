import { beforeEach, describe, expect, it, vi } from "vitest";

const jobManager = vi.hoisted(() => ({ enqueue: vi.fn(), runToCompletion: vi.fn() }));
vi.mock("@/lib/jobs/manager", () => ({ getJobManager: () => jobManager }));
vi.mock("@/lib/navigation-events", () => ({ navigationEmitter: { emit: vi.fn() } }));

import { navigationEmitter } from "@/lib/navigation-events";
import { CancelledError } from "@/lib/jobs/types";
import { TemplateInstallError } from "@/lib/jobs/runners/template-install";
import { POST } from "@/app/api/templates/cloud/install/route";

const ID = "abcdefghijklmnopqrst";
const post = (body: string) =>
  POST(new Request("http://127.0.0.1/api/templates/cloud/install", { method: "POST", body, headers: { "content-type": "application/json" } }));
const installed = { templateId: "local-1", version: 1, reinstalled: false };

beforeEach(() => {
  vi.mocked(navigationEmitter.emit).mockClear();
  jobManager.enqueue.mockReset();
  jobManager.runToCompletion.mockReset();
  jobManager.enqueue.mockResolvedValue({ status: "new", jobId: "job-1", clientKey: "k", forced: true });
  jobManager.runToCompletion.mockResolvedValue(installed);
});

describe("POST /api/templates/cloud/install", () => {
  // Review I1: the page and the agent install through ONE job, so an install has one owner.
  it("runs the template_install job — never from a cached row — and refreshes the Templates page", async () => {
    const ok = await post(JSON.stringify({ cloudId: ID }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, ...installed });
    expect(jobManager.enqueue).toHaveBeenCalledWith("template_install", { cloudId: ID }, { forceNew: true, discardOutput: false });
    expect(jobManager.runToCompletion).toHaveBeenCalledWith("job-1");
    expect(navigationEmitter.emit).toHaveBeenCalledWith("refresh_query", { queryKey: "templates" });
  });

  it("passes the version the page showed as a param, and force as discardOutput — never a param", async () => {
    await post(JSON.stringify({ cloudId: ID, version: 3, force: true }));
    expect(jobManager.enqueue).toHaveBeenCalledWith("template_install", { cloudId: ID, version: 3 }, { forceNew: true, discardOutput: true });
  });

  it("a forced call that found an install running waits for it, then runs its own re-download", async () => {
    jobManager.enqueue
      .mockResolvedValueOnce({ status: "attached_running", jobId: "job-running", clientKey: "k", existingJob: { jobId: "job-running", pieceId: null, startedAt: "" } })
      .mockResolvedValueOnce({ status: "new", jobId: "job-2", clientKey: "k", forced: true });
    jobManager.runToCompletion.mockResolvedValueOnce(installed).mockResolvedValueOnce({ ...installed, reinstalled: true });
    const r = await post(JSON.stringify({ cloudId: ID, force: true }));
    expect(await r.json()).toEqual({ ok: true, ...installed, reinstalled: true });
    expect(jobManager.runToCompletion.mock.calls.map((c) => c[0])).toEqual(["job-running", "job-2"]);
    // A plain call attaches and is done.
    jobManager.enqueue.mockResolvedValueOnce({ status: "attached_running", jobId: "job-running", clientKey: "k", existingJob: { jobId: "job-running", pieceId: null, startedAt: "" } });
    jobManager.runToCompletion.mockClear();
    await post(JSON.stringify({ cloudId: ID }));
    expect(jobManager.runToCompletion.mock.calls.map((c) => c[0])).toEqual(["job-running"]);
  });

  // A8 fix round 2, N3: the agent's Stop cancels the agent's install, not the page's.
  it("an install it attached to that another caller stopped is run again for the page, once", async () => {
    const attached = { status: "attached_running", jobId: "job-agent", clientKey: "k", existingJob: { jobId: "job-agent", pieceId: null, startedAt: "" } };
    jobManager.enqueue.mockResolvedValueOnce(attached).mockResolvedValueOnce({ status: "new", jobId: "job-page", clientKey: "k", forced: true });
    jobManager.runToCompletion.mockRejectedValueOnce(new CancelledError("job-agent")).mockResolvedValueOnce(installed);
    const r = await post(JSON.stringify({ cloudId: ID }));
    expect(await r.json()).toEqual({ ok: true, ...installed });
    expect(jobManager.runToCompletion.mock.calls.map((c) => c[0])).toEqual(["job-agent", "job-page"]);
    // Its OWN job cancelled (nothing else attached to): reported, not re-run.
    jobManager.runToCompletion.mockReset();
    jobManager.runToCompletion.mockRejectedValueOnce(new CancelledError("job-1"));
    const own = await post(JSON.stringify({ cloudId: ID }));
    expect(own.status).toBe(400);
    expect(jobManager.runToCompletion).toHaveBeenCalledTimes(1);
  });

  // The JobManager and its runners are a globalThis singleton built from whichever route bundle
  // loaded them first, so what reaches this route can be another bundle's copy of the class.
  it("recognises another bundle's copy of CancelledError and TemplateInstallError", async () => {
    const attached = { status: "attached_running", jobId: "job-agent", clientKey: "k", existingJob: { jobId: "job-agent", pieceId: null, startedAt: "" } };
    jobManager.enqueue.mockResolvedValueOnce(attached).mockResolvedValueOnce({ status: "new", jobId: "job-page", clientKey: "k", forced: true });
    jobManager.runToCompletion
      .mockRejectedValueOnce(Object.assign(new Error("Job job-agent cancelled"), { name: "CancelledError", jobId: "job-agent" }))
      .mockResolvedValueOnce(installed);
    expect(await (await post(JSON.stringify({ cloudId: ID }))).json()).toEqual({ ok: true, ...installed });

    jobManager.runToCompletion.mockReset();
    jobManager.runToCompletion.mockRejectedValueOnce(Object.assign(new Error("SITE TEXT"), { name: "TemplateInstallError", code: "not_found" }));
    const refused = await post(JSON.stringify({ cloudId: ID }));
    expect(refused.status).toBe(400);
    const body = await refused.json();
    expect(body.code).toBe("not_found");
    expect(body.error).toMatch(/no longer in the catalog/);
  });

  // A11 fix round 1: libi's copy by the install's code — never the job's message, which can carry the site's words.
  it("answers 400 in libi's own words by the install's code — never a 5xx, never the job's message — and refreshes nothing", async () => {
    const cases: Array<[unknown, string | undefined, RegExp]> = [
      [new TemplateInstallError("SITE TEXT: gone", "not_found"), "not_found", /no longer in the catalog/],
      [new TemplateInstallError("fetch failed SITE TEXT", "unreachable"), "unreachable", /Can't reach the catalog/],
      [new TemplateInstallError("SITE TEXT", "rate_limited"), "rate_limited", /Try again in a minute/],
      [new TemplateInstallError("SITE TEXT", "catalog_error"), "catalog_error", /couldn't send this template/],
      [new TemplateInstallError("version 4 SITE TEXT", "version_changed"), "version_changed", /Refresh the catalog/],
      [new TemplateInstallError("SITE TEXT", "rejected"), "rejected", /didn't pass libi's checks/],
      [new Error("SITE TEXT unexpected"), undefined, /^Couldn't install the template\.$/],
    ];
    for (const [err, code, copy] of cases) {
      jobManager.runToCompletion.mockRejectedValueOnce(err);
      const bad = await post(JSON.stringify({ cloudId: ID }));
      expect(bad.status).toBe(400);
      const body = await bad.json();
      expect(body.ok).toBe(false);
      expect(body.code).toBe(code);
      expect(body.error).toMatch(copy);
      expect(body.error).not.toContain("SITE TEXT");
    }
    expect(navigationEmitter.emit).not.toHaveBeenCalled();
  });

  it("answers 400 to a body without a well-formed cloudId, without installing anything", async () => {
    for (const body of ["{}", "not json", JSON.stringify({ cloudId: "../../etc" }), JSON.stringify({ cloudId: ID.toUpperCase() }), JSON.stringify({ cloudId: ID, force: "yes" }), JSON.stringify({ cloudId: ID, version: 0 })]) {
      const r = await post(body);
      expect(r.status, body).toBe(400);
      expect(await r.json()).toMatchObject({ ok: false });
    }
    expect(jobManager.enqueue).not.toHaveBeenCalled();
  });
});
