/**
 * The build-at-install model flow (yoloe11.onnx exported locally from
 * sha-pinned inputs — see mcp/registry/installers/tracking-pyenv.ts).
 *
 * Covers the logic that replaced the old reproduce-at-build dead end:
 *   - buildInputsOf resolves the source checkpoint sha from the manifest
 *   - isBuildCurrent / build-info marker round-trip (skip vs rebuild)
 *   - ensureBuiltModel: skips when current, exports when stale, verifies the
 *     export-only text encoder, surfaces export failures actionably
 *   - parseExportResult scans past ultralytics/uv stdout chatter
 *   - the shipped models.json no longer declares any reproduce-at-build or
 *     unpinnable entry
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  buildInputsOf,
  ensureBuiltModel,
  isBuildCurrent,
  parseExportResult,
  type BuildInfo,
  type ModelEntry,
} from "@/mcp/registry/installers/tracking-pyenv";

const sha = (b: Buffer | string) =>
  crypto.createHash("sha256").update(b).digest("hex");

const ENCODER_BYTES = Buffer.from("fake-mobileclip-bytes");
const PT_BYTES = Buffer.from("fake-checkpoint-bytes");

function makeManifest(): ModelEntry[] {
  const source: ModelEntry = {
    id: "yoloe_vp",
    file: "yoloe-11s-seg.pt",
    url: "https://example.com/yoloe-11s-seg.pt",
    sha256: sha(PT_BYTES),
    sizeBytes: PT_BYTES.length,
    dest: "yoloe-11s-seg.pt",
    acquisition: "direct-download",
  };
  const built: ModelEntry = {
    id: "yoloe11",
    file: "yoloe-11s-seg.onnx",
    url: "BUILD-AT-INSTALL",
    sha256: "",
    sizeBytes: 0,
    dest: "yoloe11.onnx",
    acquisition: "build-at-install",
    build: {
      sourceModelId: "yoloe_vp",
      classes: ["person"],
      imgsz: 640,
      opset: 17,
      clipRequirement: "clip @ https://example.com/clip.tar.gz",
      textEncoder: {
        file: ".build/mobileclip_blt.ts",
        url: "https://example.com/mobileclip_blt.ts",
        sha256: sha(ENCODER_BYTES),
        sizeBytes: ENCODER_BYTES.length,
      },
    },
  };
  return [source, built];
}

function makeModelsDir(opts: { withPt?: boolean; withEncoder?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tracking-build-"));
  if (opts.withPt !== false) {
    fs.writeFileSync(path.join(dir, "yoloe-11s-seg.pt"), PT_BYTES);
  }
  if (opts.withEncoder) {
    fs.mkdirSync(path.join(dir, ".build"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".build", "mobileclip_blt.ts"), ENCODER_BYTES);
  }
  return dir;
}

/** Fake exec that behaves like a successful export_yoloe11.py run. */
function fakeExportExec(onnxBytes = Buffer.from("fake-onnx-bytes")) {
  return vi.fn(async (_cmd: string, args: string[]) => {
    const out = args[args.indexOf("--out") + 1];
    fs.writeFileSync(out, onnxBytes);
    return {
      stdout:
        "Ultralytics 8.4.51 banner chatter\n" +
        "ONNX: export success\n" +
        JSON.stringify({
          type: "export",
          ok: true,
          out,
          sha256: sha(onnxBytes),
          sizeBytes: onnxBytes.length,
          ultralytics: "8.4.51",
        }) +
        "\n",
      stderr: "",
    };
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildInputsOf", () => {
  it("resolves the source checkpoint sha from the manifest", () => {
    const manifest = makeManifest();
    const inputs = buildInputsOf(manifest[1], manifest);
    expect(inputs).toEqual({
      sourcePtSha256: sha(PT_BYTES),
      textEncoderSha256: sha(ENCODER_BYTES),
      clipRequirement: "clip @ https://example.com/clip.tar.gz",
      classes: ["person"],
      imgsz: 640,
      opset: 17,
    });
  });

  it("throws when the source model id is not in the manifest", () => {
    const manifest = makeManifest();
    const broken = {
      ...manifest[1],
      build: { ...manifest[1].build!, sourceModelId: "nope" },
    };
    expect(() => buildInputsOf(broken, manifest)).toThrow(/nope/);
  });
});

describe("ensureBuiltModel", () => {
  it("skips the export when the build-info marker is current", async () => {
    const manifest = makeManifest();
    const dir = makeModelsDir({ withEncoder: true });
    const dest = path.join(dir, "yoloe11.onnx");
    const onnx = Buffer.from("previously-built-onnx");
    fs.writeFileSync(dest, onnx);
    const info: BuildInfo = {
      inputs: buildInputsOf(manifest[1], manifest),
      output: { sha256: sha(onnx), sizeBytes: onnx.length },
      builtAt: new Date().toISOString(),
    };
    fs.writeFileSync(`${dest}.build-info.json`, JSON.stringify(info));

    const exec = fakeExportExec();
    await ensureBuiltModel(manifest[1], manifest, dir, exec);
    expect(exec).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exports and records build-info when the artifact is missing", async () => {
    const manifest = makeManifest();
    const dir = makeModelsDir({ withEncoder: true });
    const exec = fakeExportExec();

    await ensureBuiltModel(manifest[1], manifest, dir, exec);

    expect(exec).toHaveBeenCalledTimes(1);
    const args = exec.mock.calls[0][1] as string[];
    // Runs inside the locked venv with the pinned CLIP overlay.
    expect(args.slice(0, 4)).toEqual([
      "run",
      "--locked",
      "--with",
      "clip @ https://example.com/clip.tar.gz",
    ]);
    expect(args).toContain("export_yoloe11.py");
    expect(args[args.indexOf("--classes") + 1]).toBe("person");

    const dest = path.join(dir, "yoloe11.onnx");
    expect(fs.existsSync(dest)).toBe(true);
    const info = JSON.parse(
      fs.readFileSync(`${dest}.build-info.json`, "utf-8"),
    ) as BuildInfo;
    expect(info.inputs).toEqual(buildInputsOf(manifest[1], manifest));
    expect(info.output.sha256).toBe(sha(fs.readFileSync(dest)));
    // ...and a second run is now a no-op.
    await ensureBuiltModel(manifest[1], manifest, dir, exec);
    expect(exec).toHaveBeenCalledTimes(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rebuilds when the declared inputs change (stale build-info)", async () => {
    const manifest = makeManifest();
    const dir = makeModelsDir({ withEncoder: true });
    const dest = path.join(dir, "yoloe11.onnx");
    const oldOnnx = Buffer.from("old-onnx");
    fs.writeFileSync(dest, oldOnnx);
    const staleInputs = {
      ...buildInputsOf(manifest[1], manifest),
      classes: ["person", "face"], // vocabulary changed since this build
    };
    fs.writeFileSync(
      `${dest}.build-info.json`,
      JSON.stringify({
        inputs: staleInputs,
        output: { sha256: sha(oldOnnx), sizeBytes: oldOnnx.length },
        builtAt: new Date().toISOString(),
      }),
    );

    const exec = fakeExportExec();
    await ensureBuiltModel(manifest[1], manifest, dir, exec);
    expect(exec).toHaveBeenCalledTimes(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("downloads the sha-pinned text encoder when missing", async () => {
    const manifest = makeManifest();
    const dir = makeModelsDir({ withEncoder: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(ENCODER_BYTES, { status: 200 })),
    );

    const exec = fakeExportExec();
    await ensureBuiltModel(manifest[1], manifest, dir, exec);

    const encoder = path.join(dir, ".build", "mobileclip_blt.ts");
    expect(fs.existsSync(encoder)).toBe(true);
    expect(fs.readFileSync(encoder).equals(ENCODER_BYTES)).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("rejects a text encoder download whose sha does not match", async () => {
    const manifest = makeManifest();
    const dir = makeModelsDir({ withEncoder: false });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(Buffer.from("tampered"), { status: 200 })),
    );

    const exec = fakeExportExec();
    await expect(
      ensureBuiltModel(manifest[1], manifest, dir, exec),
    ).rejects.toThrow(/sha256 mismatch/);
    expect(exec).not.toHaveBeenCalled();
    // No partial file left behind.
    expect(fs.existsSync(path.join(dir, ".build", "mobileclip_blt.ts"))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("throws actionably when the source checkpoint is not provisioned", async () => {
    const manifest = makeManifest();
    const dir = makeModelsDir({ withPt: false, withEncoder: true });
    const exec = fakeExportExec();
    await expect(
      ensureBuiltModel(manifest[1], manifest, dir, exec),
    ).rejects.toThrow(/direct-download phase/);
    expect(exec).not.toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("surfaces an export failure with the script's error message", async () => {
    const manifest = makeManifest();
    const dir = makeModelsDir({ withEncoder: true });
    const exec = vi.fn(async () => ({
      stdout:
        JSON.stringify({
          type: "export",
          ok: false,
          error: "RuntimeError: output0 channel dim 41 != 37",
        }) + "\n",
      stderr: "",
    }));
    await expect(
      ensureBuiltModel(manifest[1], manifest, dir, exec),
    ).rejects.toThrow(/output0 channel dim/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("isBuildCurrent", () => {
  it("is false when the artifact bytes no longer match the recorded sha", () => {
    const manifest = makeManifest();
    const dir = makeModelsDir();
    const dest = path.join(dir, "yoloe11.onnx");
    fs.writeFileSync(dest, "corrupted-bytes");
    const info: BuildInfo = {
      inputs: buildInputsOf(manifest[1], manifest),
      output: { sha256: sha(Buffer.from("original-bytes")), sizeBytes: 14 },
      builtAt: new Date().toISOString(),
    };
    fs.writeFileSync(`${dest}.build-info.json`, JSON.stringify(info));
    expect(isBuildCurrent(dest, info.inputs)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("parseExportResult", () => {
  it("finds the protocol line beneath trailing chatter and ignores non-export JSON", () => {
    const stdout = [
      "Ultralytics 8.4.51 🚀 Python-3.11",
      '{"type":"progress","done":1}',
      '{"type":"export","ok":true,"sha256":"abc"}',
      "some trailing uv chatter",
    ].join("\n");
    expect(parseExportResult(stdout)).toMatchObject({ ok: true, sha256: "abc" });
  });

  it("returns null when no export line exists", () => {
    expect(parseExportResult("no json here\n")).toBeNull();
  });
});

describe("shipped models.json", () => {
  it("declares no reproduce-at-build and no unpinnable entry", () => {
    const manifest = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "mcp", "tracking", "py", "models.json"),
        "utf-8",
      ),
    ) as ModelEntry[];
    for (const entry of manifest) {
      expect(["direct-download", "build-at-install"]).toContain(entry.acquisition);
      if (entry.acquisition === "direct-download") {
        expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.url).toMatch(/^https:\/\//);
      } else {
        // build-at-install: every INPUT must be sha-pinned.
        expect(entry.build).toBeTruthy();
        expect(entry.build!.textEncoder.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.build!.clipRequirement).toMatch(/@ https:\/\/.+[0-9a-f]{40}/);
        const source = manifest.find((m) => m.id === entry.build!.sourceModelId);
        expect(source?.acquisition).toBe("direct-download");
        expect(source?.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    // The dead osnet_reid ONNX entry stays deleted (boxmot's runtime PyTorch
    // ReID backend is the shipped behaviour — see libitrack/associate.py).
    expect(manifest.find((m) => m.id === "osnet_reid")).toBeUndefined();
  });
});
