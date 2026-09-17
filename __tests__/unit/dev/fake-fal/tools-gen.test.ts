import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/mcp/dev/fake-fal/placeholders", () => ({
  makePlaceholder: vi.fn(async (kind: string) => ({ id: `file-${kind}`, contentType: kind })),
}));

import { run_model, submit_job, check_job, get_job_result, upload_file } from "@/mcp/dev/fake-fal/tools";
import { fakeFalRecordPath } from "@/mcp/dev/fake-fal/recorder";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "libihome-")); process.env.LIBI_HOME = home; });
afterEach(() => { delete process.env.LIBI_HOME; rmSync(home, { recursive: true, force: true }); });
const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe("fake-fal generation tools", () => {
  it("run_model produces a file and records endpoint_id + generate_audio:false", async () => {
    const r = payload(await run_model({ endpoint_id: "openai/gpt-image-2", input: { prompt: "x" }, pieceId: "p1" }));
    expect(r.file.id).toBe("file-image");
    const rec = readFileSync(fakeFalRecordPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rec.some((c) => c.tool === "run_model" && c.endpoint_id === "openai/gpt-image-2")).toBe(true);
  });

  it("submit_job → check_job(completed) → get_job_result(file) async handshake", async () => {
    const sub = payload(await submit_job({ endpoint_id: "bytedance/seedance-2.0/image-to-video", input: { prompt: "v", generate_audio: false }, pieceId: "p1" }));
    expect(sub.request_id).toBeTruthy();
    expect(payload(check_job({ request_id: sub.request_id })).status).toBe("completed");
    const res = payload(await get_job_result({ request_id: sub.request_id }));
    expect(res.file.id).toBe("file-video");
    const rec = readFileSync(fakeFalRecordPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const submit = rec.find((c) => c.tool === "submit_job");
    expect(submit.input.generate_audio).toBe(false);
  });

  /**
   * The fake exists to make a scenario walk the path production would.
   * It had no `upload_file`, so every scenario needing a local file in front
   * of fal either invented an excuse ("no upload tool available, I'll pass the
   * storage path — we're in test mode anyway") and PASSED, or gave up. Both
   * outcomes are a scenario reporting a result about a path production
   * rejects.
   */
  it("upload_file returns a deterministic https URL for a real local file and records the call", async () => {
    const local = join(home, "clip.mp4");
    writeFileSync(local, "v");
    const first = payload(await upload_file({ path: local }));
    expect(first.success).toBe(true);
    expect(first.url).toMatch(/^https:\/\/[^/]+\/.*clip\.mp4$/);
    // Deterministic: the same path uploads to the same URL every run.
    expect(payload(await upload_file({ path: local })).url).toBe(first.url);
    const rec = readFileSync(fakeFalRecordPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rec.some((c) => c.tool === "upload_file")).toBe(true);
  });

  it("upload_file fails on a path that does not exist, the way a real upload would", async () => {
    const r = payload(await upload_file({ path: join(home, "nope.mp4") }));
    expect(r.success).toBe(false);
    expect(r.error).toBe("file_not_found");
  });

  it("run_model rejects a local path handed to a *_url input, naming upload_file", async () => {
    const r = payload(
      await run_model({
        endpoint_id: "fal-ai/veo3.1/fast/image-to-video",
        input: { prompt: "x", image_url: "/Users/me/.libi/storage/img.png" },
        pieceId: "p1",
      }),
    );
    expect(r.success).toBe(false);
    expect(r.error).toBe("invalid_input");
    expect(r.message).toMatch(/image_url/);
    expect(r.message).toMatch(/upload_file/);
    // It is still recorded: production receives the call and rejects it, and a
    // scenario has to be able to assert the attempt happened.
    const rec = readFileSync(fakeFalRecordPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rec.some((c) => c.tool === "run_model")).toBe(true);
  });

  it("submit_job rejects a loopback URL and a file:// URL, and starts no job", async () => {
    const loopback = payload(
      await submit_job({
        endpoint_id: "fal-ai/veo3.1/fast/image-to-video",
        input: { image_url: "http://127.0.0.1:3456/api/files/f1" },
        pieceId: null,
      }),
    );
    expect(loopback.success).toBe(false);
    expect(loopback.request_id).toBeUndefined();
    const fileUrl = payload(
      await submit_job({
        endpoint_id: "fal-ai/veo3.1/fast/image-to-video",
        input: { video_url: "file:///tmp/x.mp4" },
        pieceId: null,
      }),
    );
    expect(fileUrl.success).toBe(false);
  });

  it("accepts what fal accepts — an https URL, a data URI, and non-URL inputs", async () => {
    const png = join(home, "a.png");
    writeFileSync(png, "p");
    const uploaded = payload(await upload_file({ path: png }));
    const r = payload(
      await run_model({
        endpoint_id: "fal-ai/veo3.1/fast/image-to-video",
        input: {
          prompt: "a cat on a / slash",
          image_url: uploaded.url,
          mask_url: "data:image/png;base64,iVBORw0KGgo=",
          duration: "5",
        },
        pieceId: null,
      }),
    );
    expect(r.success).toBe(true);
  });
});

