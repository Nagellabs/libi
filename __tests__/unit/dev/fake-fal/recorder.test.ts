import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCall, fakeFalRecordPath } from "@/mcp/dev/fake-fal/recorder";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "libihome-")); process.env.LIBI_HOME = home; });
afterEach(() => { delete process.env.LIBI_HOME; rmSync(home, { recursive: true, force: true }); });

describe("fake-fal recorder", () => {
  it("appends one JSON line per call under <home>/test-mode/fal-calls.jsonl", () => {
    recordCall({ tool: "submit_job", endpoint_id: "bytedance/seedance-2.0/image-to-video", input: { generate_audio: false }, pieceId: "p1" });
    recordCall({ tool: "run_model", endpoint_id: "openai/gpt-image-2", input: { prompt: "x" }, pieceId: "p1" });
    const path = fakeFalRecordPath();
    expect(existsSync(path)).toBe(true);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].tool).toBe("submit_job");
    expect(lines[0].input.generate_audio).toBe(false);
    expect(typeof lines[0].ts).toBe("string");
  });
});
