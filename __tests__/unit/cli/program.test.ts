/**
 * `libi`'s argv. The root program (the bare `npx libi` studio) and
 * `serve-mcp-http` both declare `-p, --port`. Without positional options
 * commander hands a subcommand's `--port` to the ROOT, so
 * `libi serve-mcp-http --port 3458` silently bound the default port. The
 * actions are stubbed: this pins parsing only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventEmitter } from "node:events";

const actions = vi.hoisted(() => ({
  startStudio: vi.fn(async () => {}),
  serveMcp: vi.fn(async () => {}),
  serveTrackingMcp: vi.fn(async () => {}),
  serveMcpHttp: vi.fn(async () => {}),
  connectCommand: vi.fn(async () => {}),
  installStdioResilience: vi.fn(),
}));
vi.mock("@/lib/cli/studio", () => ({ startStudio: actions.startStudio }));
vi.mock("@/lib/cli/serve-mcp", () => ({ serveMcp: actions.serveMcp }));
vi.mock("@/lib/cli/serve-mcp-tracking", () => ({ serveTrackingMcp: actions.serveTrackingMcp }));
vi.mock("@/lib/cli/serve-mcp-http", () => ({ serveMcpHttp: actions.serveMcpHttp }));
vi.mock("@/lib/cli/connect-command", () => ({ connectCommand: actions.connectCommand }));
vi.mock("@/lib/cli/stdio-resilience", () => ({ installStdioResilience: actions.installStdioResilience }));

import { buildProgram, runCli } from "@/lib/cli/index";

// Captured before any test clears the mocks: importing the module must run nothing.
const callsAtImport = Object.values(actions).reduce((n, fn) => n + fn.mock.calls.length, 0);

const run = (...argv: string[]) => buildProgram().exitOverride().parseAsync(argv, { from: "user" });

describe("libi argv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("importing the CLI module parses nothing and installs nothing", () => {
    expect(callsAtImport).toBe(0);
  });

  it("serve-mcp-http --port N binds N, not the default", async () => {
    await run("serve-mcp-http", "--port", "3458");
    expect(actions.serveMcpHttp).toHaveBeenCalledWith("3458");
    expect(actions.startStudio).not.toHaveBeenCalled();
  });

  it("serve-mcp-http -p N binds N", async () => {
    await run("serve-mcp-http", "-p", "3459");
    expect(actions.serveMcpHttp).toHaveBeenCalledWith("3459");
  });

  it("serve-mcp-http with no port leaves the choice to LIBI_MCP_PORT / the default", async () => {
    await run("serve-mcp-http");
    expect(actions.serveMcpHttp).toHaveBeenCalledWith(undefined);
  });

  it("the bare root still takes --port (npx libi --port 3470), next to the open flag", async () => {
    await run("--no-open", "--port", "3470");
    expect(actions.startStudio).toHaveBeenCalledWith("3470", { open: false });
  });

  it("the bare root with no flags starts the studio on 3456 and leaves the open default undecided", async () => {
    await run();
    expect(actions.startStudio).toHaveBeenCalledWith("3456", { open: undefined });
  });

  it("studio --port still parses", async () => {
    await run("studio", "--port", "3470");
    expect(actions.startStudio).toHaveBeenCalledWith("3470", { open: undefined });
  });

  it("connect still receives its folder and --global", async () => {
    await run("connect", "some/dir", "--global");
    expect(actions.connectCommand).toHaveBeenCalledWith("some/dir", expect.objectContaining({ global: true }));
  });
});

// `program.parse()` never awaited an async `.action()`, so a rejection
// escaping it (e.g. a bug in `connectCommand`) had no attached handler at
// all — `lib/logger.ts`'s unhandledRejection listener only logs — and the
// process exited 0 having silently done nothing. `runCli` is the entry
// point's `parseAsync` + catch, exercised directly (not through `bin/libi.js`).
describe("runCli reports an escaping rejection instead of exiting silently", () => {
  it("writes a short stderr line and sets exitCode 1, without a stack", async () => {
    actions.connectCommand.mockRejectedValueOnce(new Error("boom"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const originalExitCode = process.exitCode;
    try {
      await runCli(["node", "libi", "connect"]);
      expect(stderr).toHaveBeenCalledWith("[libi] ✗ boom\n");
      expect(stderr.mock.calls.some(([chunk]) => String(chunk).includes("at "))).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      stderr.mockRestore();
      process.exitCode = originalExitCode;
    }
  });

  it("a normal run leaves exitCode untouched", async () => {
    const originalExitCode = process.exitCode;
    try {
      await runCli(["node", "libi", "connect"]);
      expect(process.exitCode).toBe(originalExitCode);
    } finally {
      process.exitCode = originalExitCode;
    }
  });
});

// `libi connect` once went idle mid-command — a lookup nothing held the event
// loop open for — and Node exited 0 with the action's promise still pending, so
// the catch above never ran and nothing was printed. `beforeExit` is the one
// signal left when that happens: while the command is unsettled it says so and
// fails the run. Once the action has settled — the studio and the serve-*
// commands settle as soon as they are serving — it stays silent.
describe("runCli never exits silently mid-command", () => {
  function fakeProc() {
    const emitter = new EventEmitter();
    return Object.assign(emitter, {
      stderr: { write: vi.fn(() => true) },
      exitCode: undefined as number | string | undefined,
    });
  }

  it("the event loop emptying while the command is pending writes one stderr line and sets exitCode 1", async () => {
    let finish: () => void = () => {};
    actions.connectCommand.mockImplementationOnce(() => new Promise<void>((r) => (finish = r)));
    const proc = fakeProc();
    const done = runCli(["node", "libi", "connect", "/tmp/x"], proc);
    await vi.waitFor(() => expect(actions.connectCommand).toHaveBeenCalled());
    proc.emit("beforeExit", 0);
    expect(proc.stderr.write).toHaveBeenCalledWith("[libi] ✗ libi stopped before the command finished.\n");
    expect(proc.exitCode).toBe(1);
    // beforeExit fires again each time the loop empties: the line is written once.
    proc.emit("beforeExit", 1);
    expect(proc.stderr.write).toHaveBeenCalledTimes(1);
    finish();
    await done;
  });

  it("once the command has settled — the studio as soon as it is serving — beforeExit writes nothing and the listener is gone", async () => {
    const proc = fakeProc();
    await runCli(["node", "libi", "--no-open"], proc);
    expect(actions.startStudio).toHaveBeenCalled();
    proc.emit("beforeExit", 0);
    expect(proc.stderr.write).not.toHaveBeenCalled();
    expect(proc.exitCode).toBeUndefined();
    expect(proc.listenerCount("beforeExit")).toBe(0);
  });

  it("a rejection is still reported through the catch on the injected process, once", async () => {
    actions.connectCommand.mockRejectedValueOnce(new Error("boom"));
    const proc = fakeProc();
    await runCli(["node", "libi", "connect"], proc);
    proc.emit("beforeExit", 0);
    expect(proc.stderr.write.mock.calls).toEqual([["[libi] ✗ boom\n"]]);
    expect(proc.exitCode).toBe(1);
  });
});
