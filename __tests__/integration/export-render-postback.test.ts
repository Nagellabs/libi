import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { POST as postResult } from "@/app/api/export/render-result/route";
import { createRenderJob, __resetRegistryForTests, type RenderPayload } from "@/lib/export/render-jobs";
import type { ExportSettings } from "@/lib/engine/types";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    });

    const res = await postResult(req);
    expect(res.status).toBe(200);

    const result = await job.done;
    expect(result.durationSeconds).toBe(2.5);
    const written = await (await import("node:fs/promises")).readFile(result.tempFilePath);
    expect(written.length).toBe(mp4Bytes.length);
  });

  it("rejects with 404 when token is wrong", async () => {
    const job = createRenderJob({ pieceId: "p1", payload: {} as RenderPayload, settings: {} as ExportSettings });
    const fd = new FormData();
    fd.append("jobId", job.jobId);
    fd.append("token", "bogus");
    fd.append("durationSeconds", "1");
    fd.append("file", new Blob([new Uint8Array([1])], { type: "video/mp4" }), "out.mp4");
    const res = await postResult(new Request("http://localhost/r", { method: "POST", body: fd }));
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
