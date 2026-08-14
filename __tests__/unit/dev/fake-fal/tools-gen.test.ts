import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("@/mcp/dev/fake-fal/placeholders", () => ({
  makePlaceholder: vi.fn(async (kind: string) => ({ id: `file-${kind}`, contentType: kind })),
}));

import { run_model, submit_job, check_job, get_job_result } from "@/mcp/dev/fake-fal/tools";
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
});
