import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// tools.ts imports placeholders.ts → file-tools (DB) + ffmpeg at module load.
// The query tools don't use them, but stub them so importing doesn't init the DB.
vi.mock("@/mcp/tools/file-tools", () => ({ storeFile: vi.fn() }));
vi.mock("@/lib/ffmpeg/exec", () => ({ runFfmpeg: vi.fn(), resolveFfmpegPath: () => "ffmpeg" }));
vi.mock("node:child_process", () => ({ spawnSync: () => ({ stdout: "drawtext" }) }));
import { recommend_model, get_model_schema, get_pricing } from "@/mcp/dev/fake-fal/tools";
import { fakeFalRecordPath } from "@/mcp/dev/fake-fal/recorder";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "libihome-")); process.env.LIBI_HOME = home; });
afterEach(() => { delete process.env.LIBI_HOME; delete process.env.LIBI_FAKE_FAL_CONFIG; rmSync(home, { recursive: true, force: true }); });

const payload = (r: { content: { text: string }[] }) => JSON.parse(r.content[0].text);

describe("fake-fal query tools", () => {
  it("recommend_model returns an endpoint and records the call", () => {
    const r = payload(recommend_model({ task: "photorealistic portrait image" }));
    // Adversarial mirror of real fal — recommends nano-banana for a portrait so the
    // skill-eval gpt-image-2 pin assertion has teeth (see recommend-model.test.ts).
    expect(r.endpoint_id).toBe("fal-ai/nano-banana-2");
    const rec = JSON.parse(readFileSync(fakeFalRecordPath(), "utf8").trim());
    expect(rec.tool).toBe("recommend_model");
  });
  it("get_model_schema returns the seedance schema with generate_audio", () => {
    const r = payload(get_model_schema({ endpoint_id: "bytedance/seedance-2.0/image-to-video" }));
    expect(r.properties.generate_audio.default).toBe(true);
  });
  it("get_pricing returns a numeric amount", () => {
    const r = payload(get_pricing({ endpoint_id: "openai/gpt-image-2" }));
    expect(typeof r.amount).toBe("number");
  });
});
