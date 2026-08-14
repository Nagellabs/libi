import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

let tmp: string;
let mockSpawnFn: ((cmd: string, args: string[]) => unknown) | null = null;

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      if (!mockSpawnFn) throw new Error("mockSpawnFn not set");
      return mockSpawnFn(cmd, args);
    }),
  };
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-analyze-"));
  process.env.LIBI_HOME = tmp;
  fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "bin", "uv"), "#!/bin/sh\n");
  mockSpawnFn = null;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

function makeChild(writeJson: Record<string, unknown>, code = 0, stderr = "") {
  return (_cmd: string, args: string[]) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
    });
    const outIdx = args.indexOf("--out");
    if (outIdx >= 0 && code === 0) {
      fs.writeFileSync(args[outIdx + 1], JSON.stringify({ ok: true, ...writeJson }));
    }
    setImmediate(() => {
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      child.emit("close", code);
    });
    return child;
  };
}

describe("ANALYZE_RUN_PREFIX", () => {
  it("pins librosa version + python 3.12", async () => {
    const { ANALYZE_RUN_PREFIX, LIBROSA_VERSION, ANALYZE_PYTHON_VERSION } = await import(
      "@/lib/music/analyze"
    );
    expect(LIBROSA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(ANALYZE_PYTHON_VERSION).toBe("3.12");
    expect(ANALYZE_RUN_PREFIX).toContain("--with");
    expect(ANALYZE_RUN_PREFIX).toContain(`librosa==${LIBROSA_VERSION}`);
    const pyIdx = ANALYZE_RUN_PREFIX.indexOf("--python");
    expect(ANALYZE_RUN_PREFIX[pyIdx + 1]).toBe("3.12");
  });
});

describe("buildAnalyzeArgs", () => {
  it("emits beats mode with required flags", async () => {
    const { buildAnalyzeArgs, ANALYZE_RUN_PREFIX } = await import("@/lib/music/analyze");
    const args = buildAnalyzeArgs(
      { mode: "beats", inPath: "/in.wav" },
      "/out.json",
    );
    expect(args.slice(0, ANALYZE_RUN_PREFIX.length)).toEqual(ANALYZE_RUN_PREFIX);
    expect(args).toContain("--mode");
    expect(args).toContain("beats");
    expect(args).toContain("--in");
    expect(args).toContain("/in.wav");
    expect(args).toContain("--out");
    expect(args).toContain("/out.json");
  });

  it("threads optional profile flags", async () => {
    const { buildAnalyzeArgs } = await import("@/lib/music/analyze");
    const args = buildAnalyzeArgs(
      {
        mode: "profile",
        inPath: "/in.wav",
        startSec: 1,
        endSec: 60,
        includeBeats: true,
        bandEnvelopes: true,
        envelopeHz: 20,
      },
      "/out.json",
    );
    expect(args).toContain("--start");
    expect(args).toContain("1");
    expect(args).toContain("--end");
    expect(args).toContain("60");
    expect(args).toContain("--include-beats");
    expect(args).toContain("--band-envelopes");
    expect(args).toContain("--envelope-hz");
    expect(args).toContain("20");
  });
});

describe("parseAnalyzeOutput", () => {
  it("returns the envelope minus the `ok` flag", async () => {
    const { parseAnalyzeOutput } = await import("@/lib/music/analyze");
    expect(parseAnalyzeOutput<{ tempo: number }>(JSON.stringify({ ok: true, tempo: 100 }))).toEqual({
      tempo: 100,
    });
  });
  it("throws on empty output", async () => {
    const { parseAnalyzeOutput, MusicAnalyzeError } = await import("@/lib/music/analyze");
    expect(() => parseAnalyzeOutput("   ")).toThrow(MusicAnalyzeError);
  });
  it("throws on malformed JSON", async () => {
    const { parseAnalyzeOutput, MusicAnalyzeError } = await import("@/lib/music/analyze");
    expect(() => parseAnalyzeOutput("{not json")).toThrow(MusicAnalyzeError);
  });
  it("throws when ok != true", async () => {
    const { parseAnalyzeOutput, MusicAnalyzeError } = await import("@/lib/music/analyze");
    expect(() => parseAnalyzeOutput(JSON.stringify({ ok: false }))).toThrow(MusicAnalyzeError);
  });
});

describe("runMusicAnalyze", () => {
  it("resolves the parsed beats envelope on success", async () => {
    mockSpawnFn = makeChild({ tempo: 89, beatTimes: [0.1, 0.5], onsetTimes: [], durationSeconds: 12, truncated: false, tempoConfidence: 0.9 });
    const { detectBeats } = await import("@/lib/music/analyze");
    const r = await detectBeats({ inPath: "/in.wav" });
    expect(r.tempo).toBe(89);
    expect(r.beatTimes).toEqual([0.1, 0.5]);
  });

  it("surfaces the tail of stderr on non-zero exit", async () => {
    const huge = "x".repeat(2000) + "\nRuntimeError: ANALYZE_TEST_SENTINEL";
    mockSpawnFn = makeChild({}, 1, huge);
    const { detectBeats, MusicAnalyzeError } = await import("@/lib/music/analyze");
    await expect(detectBeats({ inPath: "/in.wav" })).rejects.toMatchObject({
      name: "MusicAnalyzeError",
      message: expect.stringContaining("ANALYZE_TEST_SENTINEL"),
    });
    void MusicAnalyzeError;
  });
});
