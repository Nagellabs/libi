import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

const fixture = JSON.parse(
  fs.readFileSync(
    path.resolve("__tests__/fixtures/music/acestep.gen-output.json"),
    "utf-8",
  ),
);

let tmp: string;
let mockSpawnFn: ((cmd: string, args: string[]) => unknown) | null = null;

vi.mock("child_process", async () => {
  const actual =
    await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: vi.fn((cmd: string, args: string[]) => {
      if (!mockSpawnFn) throw new Error("mockSpawnFn not set");
      return mockSpawnFn(cmd, args);
    }),
  };
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-music-"));
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

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(stdoutJson: string, code = 0, stderr = "", progress = true) {
  return (_cmd: string, args: string[]) => {
    const child = new EventEmitter() as MockChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const outIdx = args.indexOf("--out");
    if (outIdx >= 0) fs.writeFileSync(args[outIdx + 1], Buffer.from("RIFFWAVE"));
    setImmediate(() => {
      if (progress) {
        child.stderr.emit("data", Buffer.from("PROGRESS 1/2\n"));
        child.stderr.emit("data", Buffer.from("PROGRESS 2/2\n"));
      }
      if (stderr) child.stderr.emit("data", Buffer.from(stderr));
      if (stdoutJson) child.stdout.emit("data", Buffer.from(stdoutJson));
      child.emit("close", code);
    });
    return child;
  };
}

describe("ACESTEP_RUN_PREFIX", () => {
  it("installs from a pinned git SHA on the official ACE-Step repo", async () => {
    const { ACESTEP_RUN_PREFIX, ACESTEP_INSTALL_SPEC } = await import(
      "@/lib/music/generate"
    );
    const { ACESTEP_GIT_REPO, ACESTEP_GIT_SHA } = await import(
      "@/lib/music/models"
    );
    // PyPI sdist is broken; we install from the upstream GitHub repo at a
    // pinned commit. Both the PEP 508 name (`ace-step`) and the SHA-pinned
    // URL must appear in the install spec.
    expect(ACESTEP_INSTALL_SPEC).toContain("ace-step");
    expect(ACESTEP_INSTALL_SPEC).toContain(`git+${ACESTEP_GIT_REPO}`);
    expect(ACESTEP_INSTALL_SPEC).toContain(`@${ACESTEP_GIT_SHA}`);
    expect(ACESTEP_RUN_PREFIX).toContain(ACESTEP_INSTALL_SPEC);
  });

  it("pins --python 3.12 (spacy==3.8.4 wheel gap on cp313/cp314)", async () => {
    const { ACESTEP_RUN_PREFIX, ACESTEP_PYTHON_VERSION } = await import(
      "@/lib/music/generate"
    );
    expect(ACESTEP_PYTHON_VERSION).toBe("3.12");
    const pyIdx = ACESTEP_RUN_PREFIX.indexOf("--python");
    expect(pyIdx).toBeGreaterThanOrEqual(0);
    expect(ACESTEP_RUN_PREFIX[pyIdx + 1]).toBe("3.12");
  });

  it("explicitly installs torchcodec (ace-step's save path needs it)", async () => {
    // Regression: ace-step calls torchaudio.save_with_torchcodec for WAV
    // output but does NOT declare torchcodec in its requirements. Without
    // an explicit --with, diffusion completes (27/27) and then save dies
    // with "TorchCodec is required for save_with_torchcodec". Verify the
    // run prefix names torchcodec at a pinned version.
    const { ACESTEP_RUN_PREFIX, TORCHCODEC_VERSION } = await import(
      "@/lib/music/generate"
    );
    expect(TORCHCODEC_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    const withFlags = ACESTEP_RUN_PREFIX.reduce<string[]>((acc, v, i) => {
      if (v === "--with") acc.push(ACESTEP_RUN_PREFIX[i + 1]);
      return acc;
    }, []);
    expect(withFlags).toContain(`torchcodec==${TORCHCODEC_VERSION}`);
  });
});

describe("buildAceStepArgs", () => {
  it("constructs the uv run argv for generation", async () => {
    const { buildAceStepArgs, ACESTEP_RUN_PREFIX } = await import(
      "@/lib/music/generate"
    );
    const args = buildAceStepArgs({
      scriptPath: "/repo/mcp/music/generate.py",
      promptFile: "/tmp/p.txt",
      lyricsFile: "/tmp/l.txt",
      durationSeconds: 30,
      seed: 7,
      modelDir: "/m",
      outPath: "/tmp/o.wav",
      instrumental: true,
    });
    expect(args).toEqual([
      ...ACESTEP_RUN_PREFIX,
      "/repo/mcp/music/generate.py",
      "--prompt-file", "/tmp/p.txt",
      "--lyrics-file", "/tmp/l.txt",
      "--duration", "30",
      "--seed", "7",
      "--model-dir", "/m",
      "--out", "/tmp/o.wav",
      "--instrumental",
    ]);
  });

  it("constructs the download-only argv", async () => {
    const { buildAceStepArgs, ACESTEP_RUN_PREFIX } = await import(
      "@/lib/music/generate"
    );
    expect(
      buildAceStepArgs({
        scriptPath: "/s.py",
        modelDir: "/m",
        downloadOnly: true,
      }),
    ).toEqual([...ACESTEP_RUN_PREFIX, "/s.py", "--model-dir", "/m", "--download-only"]);
  });
});

describe("parseGenerateStdout", () => {
  it("parses the JSON contract", async () => {
    const { parseGenerateStdout } = await import("@/lib/music/generate");
    const r = parseGenerateStdout(JSON.stringify(fixture));
    expect(r.sampleRate).toBe(48000);
    expect(r.durationSeconds).toBe(8.0);
    expect(r.channels).toBe(2);
    expect(r.seed).toBe(12345);
  });

  it("throws on empty / malformed / not-ok", async () => {
    const { parseGenerateStdout, AceStepGenerateError } = await import(
      "@/lib/music/generate"
    );
    expect(() => parseGenerateStdout("")).toThrow(AceStepGenerateError);
    expect(() => parseGenerateStdout("nope")).toThrow(AceStepGenerateError);
    expect(() => parseGenerateStdout(JSON.stringify({ ok: false }))).toThrow(
      AceStepGenerateError,
    );
  });
});

describe("generateMusic", () => {
  it("spawns uv, bridges progress, returns wavPath + parsed result", async () => {
    mockSpawnFn = makeChild(JSON.stringify(fixture));
    const { generateMusic } = await import("@/lib/music/generate");
    const ticks: Array<[number, number]> = [];
    const r = await generateMusic(
      { prompt: "calm lofi", durationSeconds: 8, instrumental: true },
      (d, t) => ticks.push([d, t]),
      () => false,
    );
    expect(fs.existsSync(r.wavPath)).toBe(true);
    expect(r.sampleRate).toBe(48000);
    expect(r.channels).toBe(2);
    expect(ticks).toContainEqual([2, 2]);
    fs.rmSync(r.wavPath, { force: true });
  });

  it("maps exit 3 to a MODEL_LOAD_FAILED error", async () => {
    mockSpawnFn = makeChild("", 3, "model load failed: boom", false);
    const { generateMusic, AceStepGenerateError } = await import(
      "@/lib/music/generate"
    );
    await expect(
      generateMusic({ prompt: "x", durationSeconds: 8 }),
    ).rejects.toMatchObject({
      name: "AceStepGenerateError",
      message: expect.stringContaining("MODEL_LOAD_FAILED"),
    });
    void AceStepGenerateError;
  });

  it("surfaces the TAIL of stderr on failure (Python traceback at the end)", async () => {
    // Regression: previously we sliced(0, 500), so a multi-KB stderr
    // showed only uv's "Installed 145 packages" banner and a torch
    // deprecation warning — never the actual exception. Build a realistic
    // stderr where the exception is at the very end and assert that's
    // what reaches the caller.
    const preamble = "Installed 145 packages in 961ms\n".repeat(20); // ~600 chars
    const middleNoise = "PROGRESS 5/27\nPROGRESS 6/27\nPROGRESS 7/27\n".repeat(
      50,
    ); // PROGRESS lines we want stripped
    const realError =
      "Traceback (most recent call last):\n" +
      '  File "/site-packages/acestep/pipeline_ace_step.py", line 412, in __call__\n' +
      "    out = self.transformer(latents, t, ...)\n" +
      "RuntimeError: ACESTEP_QA_SENTINEL: synthetic failure for tail-surfacing test";
    const stderr = preamble + middleNoise + realError;
    mockSpawnFn = makeChild("", 1, stderr, false);
    const { generateMusic } = await import("@/lib/music/generate");
    await expect(
      generateMusic({ prompt: "x", durationSeconds: 8 }),
    ).rejects.toMatchObject({
      name: "AceStepGenerateError",
      message: expect.stringContaining("ACESTEP_QA_SENTINEL"),
    });
  });

  it("formatStderrTail strips ANSI + PROGRESS noise and keeps the tail", async () => {
    const { formatStderrTail } = await import("@/lib/music/generate");
    const ansiBanner = "\x1b[2mInstalled \x1b[1m145 packages\x1b[0m\n";
    const progressNoise = "PROGRESS 1/10\nPROGRESS 2/10\n".repeat(200);
    // A genuinely large NON-PROGRESS preamble so post-strip length > cap.
    const dep = "WARNING: torch.nn.utils.weight_norm is deprecated.\n".repeat(
      30,
    );
    const trail = "RuntimeError: BANG at the end\n";
    const big = ansiBanner + progressNoise + dep + trail;
    const out = formatStderrTail(big, 500);
    // ANSI escapes gone, PROGRESS lines gone, trail preserved.
    expect(out).not.toMatch(/\[[0-9;]+m/);
    expect(out).not.toMatch(/PROGRESS \d+\/\d+/);
    expect(out).toContain("RuntimeError: BANG at the end");
    // Truncation banner present when we exceeded maxChars.
    expect(out).toMatch(/truncated, showing last 500/);
    expect(out.length).toBeLessThan(700); // 500 + banner
  });

  it("formatStderrTail returns the full string when below the cap", async () => {
    const { formatStderrTail } = await import("@/lib/music/generate");
    const small = "RuntimeError: short and sweet\n";
    expect(formatStderrTail(small, 4000)).toBe(small.trim());
  });

  it("kills the child and throws when shouldCancel() turns true", async () => {
    let killed: boolean | undefined;
    mockSpawnFn = (_cmd, args) => {
      const child = new EventEmitter() as MockChild;
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn(() => {
        killed = true;
      });
      setImmediate(() => child.stderr.emit("data", Buffer.from("PROGRESS 1/2\n")));
      void args;
      return child;
    };
    const { generateMusic, AceStepGenerateError } = await import(
      "@/lib/music/generate"
    );
    await expect(
      generateMusic({ prompt: "x", durationSeconds: 8 }, undefined, () => true),
    ).rejects.toBeInstanceOf(AceStepGenerateError);
    expect(killed).toBe(true);
  });

  it("rejects empty / oversized prompt before spawning", async () => {
    const { generateMusic, AceStepGenerateError } = await import(
      "@/lib/music/generate"
    );
    await expect(
      generateMusic({ prompt: "   ", durationSeconds: 8 }),
    ).rejects.toBeInstanceOf(AceStepGenerateError);
    await expect(
      generateMusic({ prompt: "x".repeat(1001), durationSeconds: 8 }),
    ).rejects.toBeInstanceOf(AceStepGenerateError);
  });
});

describe("MUSIC_GENERATE_MIN_FREE_BYTES + describeMemoryShortfall", () => {
  it("MUSIC_GENERATE_MIN_FREE_BYTES is the 14 GB headroom we documented", async () => {
    const { MUSIC_GENERATE_MIN_FREE_BYTES } = await import(
      "@/lib/music/generate"
    );
    // 14 GB exactly. Reading the actual value here so any future bump is a
    // deliberate test edit, not a silent change.
    expect(MUSIC_GENERATE_MIN_FREE_BYTES).toBe(14 * 1024 * 1024 * 1024);
  });

  it("describeMemoryShortfall mentions free / total / required in plain English", async () => {
    const { describeMemoryShortfall } = await import("@/lib/music/generate");
    const msg = describeMemoryShortfall(
      2 * 1024 * 1024 * 1024, // 2 GB free
      16 * 1024 * 1024 * 1024, // 16 GB total
    );
    expect(msg).toMatch(/14 GB/); // required
    expect(msg).toMatch(/2\.0 GB/); // free
    expect(msg).toMatch(/16 GB/); // total
    expect(msg).toMatch(/Close some apps/i);
  });
});
