/**
 * A failed Kokoro run reaches libi.log, not only the tool result.
 *
 * 0.1.16 full verification F7: Kokoro exited 1 on a long espeak-ng data path
 * and the only place the error surfaced was the agent's tool result —
 * `libi.log` had nothing to grep. Every non-zero exit, the timeout and a spawn
 * error now log `tts/synth_failed`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

let makeChild: (() => MockChild) | null = null;
let lastSpawnEnv: NodeJS.ProcessEnv | undefined;

vi.mock("child_process", async () => {
  const actual = await vi.importActual<typeof import("child_process")>("child_process");
  return {
    ...actual,
    spawn: vi.fn((_cmd: string, _args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      if (!makeChild) throw new Error("makeChild not set up");
      lastSpawnEnv = opts?.env;
      return makeChild();
    }),
  };
});

const warn = vi.fn();
vi.mock("@/lib/logger", async () => {
  const actual = await vi.importActual<typeof import("@/lib/logger")>("@/lib/logger");
  const spy = { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { ...actual, serverLogger: spy, mcpLogger: spy };
});

function child(): MockChild {
  const c = new EventEmitter() as MockChild;
  c.stdout = new EventEmitter();
  c.stderr = new EventEmitter();
  c.kill = vi.fn();
  return c;
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tts-log-"));
  process.env.LIBI_HOME = tmp;
  fs.mkdirSync(path.join(tmp, "bin"), { recursive: true });
  // Both spellings, so the uv lookup resolves whatever platform runs this.
  fs.writeFileSync(path.join(tmp, "bin", "uv"), "#!/bin/sh\n");
  fs.writeFileSync(path.join(tmp, "bin", "uv.exe"), "");
  makeChild = null;
  lastSpawnEnv = undefined;
  warn.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const PHONTAB =
  "Error processing file '/Users/runner/work/espeakng-loader/espeak-ng-data/phontab': No such file or directory.";

describe("synthesizeSpeech failure logging", () => {
  it("a non-zero exit logs tts/synth_failed with the code and stderr", async () => {
    makeChild = () => {
      const c = child();
      setImmediate(() => {
        c.stderr.emit("data", Buffer.from(PHONTAB));
        c.emit("close", 1);
      });
      return c;
    };
    const { synthesizeSpeech } = await import("@/lib/tts/synthesize");
    await expect(synthesizeSpeech({ text: "hello" })).rejects.toThrow(/kokoro exited 1/);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "tts", op: "synth_failed", code: 1, stderr: PHONTAB }),
      expect.any(String),
    );
  });

  it("logs the TAIL of stderr, capped at 500 characters", async () => {
    // uv's download/install chatter comes first; the real error comes last.
    const long = "uv: Downloading onnxruntime\n".repeat(80) + PHONTAB;
    makeChild = () => {
      const c = child();
      setImmediate(() => {
        c.stderr.emit("data", Buffer.from(long));
        c.emit("close", 1);
      });
      return c;
    };
    const { synthesizeSpeech } = await import("@/lib/tts/synthesize");
    await expect(synthesizeSpeech({ text: "hello" })).rejects.toThrow();
    const fields = warn.mock.calls[0][0] as { stderr: string };
    expect(fields.stderr).toHaveLength(500);
    expect(fields.stderr.endsWith(PHONTAB)).toBe(true);
  });

  it("a spawn error logs tts/synth_failed", async () => {
    makeChild = () => {
      const c = child();
      setImmediate(() => c.emit("error", new Error("spawn EACCES")));
      return c;
    };
    const { synthesizeSpeech } = await import("@/lib/tts/synthesize");
    await expect(synthesizeSpeech({ text: "hello" })).rejects.toThrow(/uv spawn failed/);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "tts", op: "synth_failed", reason: "spawn_error", err: "spawn EACCES" }),
      expect.any(String),
    );
  });

  it("the timeout logs tts/synth_failed and kills the child", async () => {
    vi.useFakeTimers();
    let spawned: MockChild | null = null;
    makeChild = () => (spawned = child());
    const { synthesizeSpeech } = await import("@/lib/tts/synthesize");
    const p = synthesizeSpeech({ text: "hello" });
    const settled = expect(p).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(10 * 60_000 + 1);
    await settled;
    expect(spawned!.kill).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ tag: "tts", op: "synth_failed", reason: "timeout" }),
      expect.any(String),
    );
  });

  it("a clean run logs nothing and hands the child libi's home", async () => {
    makeChild = () => {
      const c = child();
      setImmediate(() => {
        c.stdout.emit(
          "data",
          Buffer.from(JSON.stringify({ ok: true, voice: "af_heart", sample_rate: 24000, duration_seconds: 1, words: [] })),
        );
        c.emit("close", 0);
      });
      return c;
    };
    const { synthesizeSpeech } = await import("@/lib/tts/synthesize");
    await synthesizeSpeech({ text: "hello" });
    expect(warn).not.toHaveBeenCalled();
    // synthesize.py builds its short espeak-ng data path under <LIBI_HOME>/tts.
    expect(lastSpawnEnv?.LIBI_HOME).toBe(tmp);
  });
});
