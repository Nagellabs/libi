import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  ensureModel,
  type ModelEntry,
} from "@/mcp/registry/installers/tracking-pyenv";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ensureModel nested dest", () => {
  it("creates intermediate directories for a nested direct-download dest", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "matte-models-"));
    const bytes = Buffer.from("fake-safetensors-bytes");
    const sha = crypto.createHash("sha256").update(bytes).digest("hex");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes, { status: 200 })),
    );
    const entry: ModelEntry = {
      id: "matanyone_weights",
      file: "model.safetensors",
      url: "https://example.com/model.safetensors",
      sha256: sha,
      sizeBytes: bytes.length,
      dest: "matanyone/model.safetensors",
      acquisition: "direct-download",
    };
    await ensureModel(entry, dir);
    const written = path.join(dir, "matanyone", "model.safetensors");
    expect(fs.existsSync(written)).toBe(true);
    expect(fs.readFileSync(written).equals(bytes)).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
