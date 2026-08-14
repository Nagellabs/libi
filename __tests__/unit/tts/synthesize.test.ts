import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve("__tests__/fixtures/tts/kokoro.synth-output.json"),
    "utf-8",
  ),
);

let tmp: string;
let mockSpawnFn: ((cmd: string, args: string[]) => MockChild) | null = null;

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>(
    "child_process",
  );
  return {
    ...actual,
    spawn: vi.fn((_cmd: string, args: string[]) => {
      if (!mockSpawnFn) {
        throw new Error("mockSpawnFn not set up");
      }
      return mockSpawnFn(_cmd, args);
    }),
  };
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tts-"));
  process.env.LIBI_HOME = tmp;
  // a resolvable uv so resolveUvPath() doesn't throw
  fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "bin", "uv"), "#!/bin/sh\n");
  mockSpawnFn = null;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

/** Stub child: emits `stdoutJson` on stdout, writes `wav` bytes to the
 *  --out path, exits `code`. */
type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function createMockSpawn(stdoutJson: string, code = 0, stderr = "") {
  return (_cmd: string, args: string[]) => {
    const child = new EventEmitter() as MockChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const outIdx = args.indexOf("--out");
    if (outIdx >= 0) fs.writeFileSync(args[outIdx + 1], Buffer.from("RIFFWAVE"));
    setImmediate(() => {
      if (stdoutJson) child.stdout.emit("data", Buffer.from(stdoutJson));
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  };
}

describe("buildKokoroArgs", () => {
  it("constructs the uv run argv for synthesis", async () => {
    const { buildKokoroArgs, KOKORO_RUN_PREFIX } = await import("@/lib/tts/synthesize");
    const args = buildKokoroArgs({
      scriptPath: "/repo/mcp/tts/synthesize.py",
      textFile: "/tmp/t.txt",
      voice: "am_adam",
      speed: 1.25,
      lang: "en-us",
      modelDir: "/m",
      outPath: "/tmp/o.wav",
      timestamps: true,
    });
    expect(args).toEqual([
      ...KOKORO_RUN_PREFIX,
      "/repo/mcp/tts/synthesize.py",
      "--text-file", "/tmp/t.txt",
      "--voice", "am_adam",
      "--speed", "1.25",
      "--lang", "en-us",
      "--model-dir", "/m",
      "--out", "/tmp/o.wav",
      "--timestamps",
    ]);
  });

  it("constructs the validate-only argv", async () => {
    const { buildKokoroArgs, KOKORO_RUN_PREFIX } = await import("@/lib/tts/synthesize");
    expect(
      buildKokoroArgs({
        scriptPath: "/s.py",
        modelDir: "/m",
        downloadOnly: true,
      }),
    ).toEqual([...KOKORO_RUN_PREFIX, "/s.py", "--model-dir", "/m", "--download-only"]);
  });
});

describe("parseSynthesisStdout", () => {
  it("parses the JSON contract", async () => {
    const { parseSynthesisStdout } = await import("@/lib/tts/synthesize");
    const r = parseSynthesisStdout(JSON.stringify(fixture));
    expect(r.sampleRate).toBe(24000);
    expect(r.durationSeconds).toBe(1.6);
    expect(r.words.map((w) => w.text)).toEqual(["Welcome", "to", "Libi"]);
  });

  it("throws on empty / malformed / not-ok", async () => {
    const { parseSynthesisStdout, KokoroSynthesizeError } = await import("@/lib/tts/synthesize");
    expect(() => parseSynthesisStdout("")).toThrow(KokoroSynthesizeError);
    expect(() => parseSynthesisStdout("nope")).toThrow(KokoroSynthesizeError);
    expect(() => parseSynthesisStdout(JSON.stringify({ ok: false }))).toThrow(
      KokoroSynthesizeError,
    );
  });
});

describe("synthesizeSpeech", () => {
  it("spawns uv, returns wavPath + parsed result", async () => {
    mockSpawnFn = createMockSpawn(JSON.stringify(fixture));
    const { synthesizeSpeech } = await import("@/lib/tts/synthesize");
    const r = await synthesizeSpeech({ text: "Welcome to Libi", withTimestamps: true });
    expect(fs.existsSync(r.wavPath)).toBe(true);
    expect(r.sampleRate).toBe(24000);
    expect(r.voice).toBe("af_heart");
    expect(r.words).toHaveLength(3);
    fs.rmSync(r.wavPath, { force: true });
  });

  it("maps non-zero exit to KokoroSynthesizeError", async () => {
    mockSpawnFn = createMockSpawn("", 1, "synthesis failed: boom");
    const { synthesizeSpeech, KokoroSynthesizeError } = await import("@/lib/tts/synthesize");
    await expect(synthesizeSpeech({ text: "hi" })).rejects.toBeInstanceOf(
      KokoroSynthesizeError,
    );
  });

  it("rejects empty / oversized text before spawning", async () => {
    const { synthesizeSpeech, KokoroSynthesizeError } = await import("@/lib/tts/synthesize");
    await expect(synthesizeSpeech({ text: "   " })).rejects.toBeInstanceOf(
      KokoroSynthesizeError,
    );
    await expect(
      synthesizeSpeech({ text: "x".repeat(5001) }),
    ).rejects.toBeInstanceOf(KokoroSynthesizeError);
  });
});

describe("fetchModelFiles", () => {
  it("skips files that already exist non-empty", async () => {
    const { fetchModelFiles } = await import("@/lib/tts/synthesize");
    const { kokoroModelPaths } = await import("@/lib/tts/voices");
    const { onnxPath, voicesPath } = kokoroModelPaths();
    fs.mkdirSync(path.dirname(onnxPath), { recursive: true });
    fs.writeFileSync(onnxPath, "already");
    fs.writeFileSync(voicesPath, "already");
    const spy = vi.fn();
    await fetchModelFiles(spy); // downloader must NOT be called
    expect(spy).not.toHaveBeenCalled();
  });

  it("downloads missing files via the injected fetcher", async () => {
    const { fetchModelFiles } = await import("@/lib/tts/synthesize");
    const { kokoroModelPaths } = await import("@/lib/tts/voices");
    const { onnxPath, voicesPath } = kokoroModelPaths();
    const got: string[] = [];
    await fetchModelFiles(async (url: string, dest: string) => {
      got.push(url);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, "bytes");
    });
    expect(got).toHaveLength(2);
    expect(fs.readFileSync(onnxPath, "utf-8")).toBe("bytes");
    expect(fs.readFileSync(voicesPath, "utf-8")).toBe("bytes");
  });
});
