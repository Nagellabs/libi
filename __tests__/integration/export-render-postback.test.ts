import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { POST as postResult } from "@/app/api/export/render-result/route";
import { createRenderJob, __resetRegistryForTests, type RenderPayload } from "@/lib/export/render-jobs";
import type { ExportSettings } from "@/lib/engine/types";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** What the real render page sends: a same-origin POST to the loopback studio
 *  (measured live in Chromium — Host, a matching Origin, Sec-Fetch-Site
 *  same-origin). The route re-runs the origin guard itself (it sits outside
 *  proxy.ts), and a `Request` built here carries no headers unless given. */
const LOOPBACK = { host: "127.0.0.1:3456", origin: "http://127.0.0.1:3456", "sec-fetch-site": "same-origin" };

describe("POST /api/export/render-result", () => {
  let tmp: string;
  beforeEach(async () => {
    __resetRegistryForTests();
    tmp = await mkdtemp(join(tmpdir(), "libi-render-test-"));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it("writes the MP4 bytes to disk and resolves the job", async () => {
    const job = createRenderJob({
      pieceId: "p1",
      payload: { id: "c1" } as unknown as RenderPayload,
      settings: { format: "mp4" } as ExportSettings,
    });

    const mp4Bytes = new Uint8Array([0, 0, 0, 20, 102, 116, 121, 112]); // ftyp magic
    const fd = new FormData();
    fd.append("jobId", job.jobId);
    fd.append("token", job.token);
    fd.append("durationSeconds", "2.5");
    fd.append("file", new Blob([mp4Bytes], { type: "video/mp4" }), "out.mp4");

    const req = new Request("http://localhost/api/export/render-result", {
      method: "POST",
      body: fd,
      headers: LOOPBACK,
    });

    const res = await postResult(req);
    expect(res.status).toBe(200);

    const result = await job.done;
    expect(result.durationSeconds).toBe(2.5);
    const written = await (await import("node:fs/promises")).readFile(result.tempFilePath);
    expect(written.length).toBe(mp4Bytes.length);
  });

  it("parses droppedOverlays JSON and forwards it to the resolved job (QA 2026-09-18 B1)", async () => {
    const job = createRenderJob({
      pieceId: "p1",
      payload: { id: "c1" } as unknown as RenderPayload,
      settings: { format: "mp4" } as ExportSettings,
    });

    const fd = new FormData();
    fd.append("jobId", job.jobId);
    fd.append("token", job.token);
    fd.append("durationSeconds", "2.5");
    fd.append(
      "droppedOverlays",
      JSON.stringify([{ id: "code-abc", message: "ctx is not defined" }]),
    );
    fd.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" }), "out.mp4");

    const req = new Request("http://localhost/api/export/render-result", {
      method: "POST",
      body: fd,
      headers: LOOPBACK,
    });
    const res = await postResult(req);
    expect(res.status).toBe(200);

    const result = await job.done;
    expect(result.droppedOverlays).toEqual([{ id: "code-abc", message: "ctx is not defined" }]);
  });

  // QA recheck N5: uploaded fonts the render page couldn't load are reported
  // so the export runner can log them (the text fell back to a default face).
  it("parses unloadedFonts and forwards it to the resolved job", async () => {
    const job = createRenderJob({
      pieceId: "p1",
      payload: { id: "c1" } as unknown as RenderPayload,
      settings: { format: "mp4" } as ExportSettings,
    });
    const fd = new FormData();
    fd.append("jobId", job.jobId);
    fd.append("token", job.token);
    fd.append("durationSeconds", "2.5");
    fd.append("unloadedFonts", JSON.stringify([{ fontFileId: "font-1", reason: "OTS parsing error" }, 7, { fontFileId: 3 }]));
    fd.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" }), "out.mp4");
    const res = await postResult(new Request("http://localhost/api/export/render-result", { method: "POST", body: fd, headers: LOOPBACK }));
    expect(res.status).toBe(200);
    expect((await job.done).unloadedFonts).toEqual([{ fontFileId: "font-1", reason: "OTS parsing error" }]);
  });

  it("omits droppedOverlays from the resolved job when the field is absent", async () => {
    const job = createRenderJob({
      pieceId: "p1",
      payload: { id: "c1" } as unknown as RenderPayload,
      settings: { format: "mp4" } as ExportSettings,
    });
    const fd = new FormData();
    fd.append("jobId", job.jobId);
    fd.append("token", job.token);
    fd.append("durationSeconds", "2.5");
    fd.append("file", new Blob([new Uint8Array([1])], { type: "video/mp4" }), "out.mp4");
    const res = await postResult(
      new Request("http://localhost/api/export/render-result", { method: "POST", body: fd, headers: LOOPBACK }),
    );
    expect(res.status).toBe(200);
    const result = await job.done;
    expect(result.droppedOverlays).toBeUndefined();
  });

  it("ignores malformed droppedOverlays JSON rather than failing the postback", async () => {
    const job = createRenderJob({
      pieceId: "p1",
      payload: { id: "c1" } as unknown as RenderPayload,
      settings: { format: "mp4" } as ExportSettings,
    });
    const fd = new FormData();
    fd.append("jobId", job.jobId);
    fd.append("token", job.token);
    fd.append("durationSeconds", "2.5");
    fd.append("droppedOverlays", "{not json");
    fd.append("file", new Blob([new Uint8Array([1])], { type: "video/mp4" }), "out.mp4");
    const res = await postResult(
      new Request("http://localhost/api/export/render-result", { method: "POST", body: fd, headers: LOOPBACK }),
    );
    expect(res.status).toBe(200);
    const result = await job.done;
    expect(result.droppedOverlays).toBeUndefined();
  });

  it("refuses a cross-site postback even with a valid token (guard re-run outside the proxy)", async () => {
    const job = createRenderJob({ pieceId: "p1", payload: { id: "c1" } as unknown as RenderPayload, settings: { format: "mp4" } as ExportSettings });
    const fd = new FormData();
    fd.append("jobId", job.jobId);
    fd.append("token", job.token);
    fd.append("durationSeconds", "1");
    fd.append("file", new Blob([new Uint8Array([0, 0, 0, 20])], { type: "video/mp4" }), "out.mp4");
    const crossSite = await postResult(new Request("http://127.0.0.1:3456/api/export/render-result", { method: "POST", body: fd, headers: { host: "127.0.0.1:3456", "sec-fetch-site": "cross-site" } }));
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ error: "forbidden_cross_origin" });
    const rebound = await postResult(new Request("http://rebind.attacker.example/api/export/render-result", { method: "POST", body: fd, headers: { host: "rebind.attacker.example" } }));
    expect(rebound.status).toBe(403);
    expect(await rebound.json()).toMatchObject({ error: "forbidden_cross_origin" });
  });

  it("rejects with 404 when token is wrong", async () => {
    const job = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    const fd = new FormData();
    fd.append("jobId", job.jobId);
    fd.append("token", "bogus");
    fd.append("durationSeconds", "1");
    fd.append("file", new Blob([new Uint8Array([1])], { type: "video/mp4" }), "out.mp4");
    const res = await postResult(new Request("http://localhost/r", { method: "POST", body: fd, headers: LOOPBACK }));
    expect(res.status).toBe(404);
  });
});

import { POST as postError } from "@/app/api/export/render-error/route";

describe("POST /api/export/render-error", () => {
  beforeEach(() => __resetRegistryForTests());

  it("rejects the job promise with the provided message", async () => {
    const job = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    const req = new Request("http://localhost/api/export/render-error", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId: job.jobId, token: job.token, message: "boom" }),
    });
    const res = await postError(req);
    expect(res.status).toBe(200);
    await expect(job.done).rejects.toThrow("boom");
  });
});
