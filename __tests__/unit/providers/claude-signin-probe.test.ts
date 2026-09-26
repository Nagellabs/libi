// Asking Claude Code whether it has signed in to an MCP server (lib/providers/claude-signin-probe.ts). The parse runs
// against output captured from claude 2.1.282 under a scratch CLAUDE_CONFIG_DIR; the lookup against an injected
// `mcp get`; the bounded spawn against small node scripts in a temp folder. No real claude, config or keychain is used.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLAUDE_LOGIN_MAX_MS,
  CLAUDE_SIGNIN_MEMO_MS,
  CLAUDE_SIGNIN_REVALIDATE_AFTER_MS,
  CLAUDE_SIGNIN_UNKNOWN_MEMO_MS,
  __clearClaudeSignInMemo,
  __resetClaudeSignInProbe,
  endClaudeLoginsOf,
  lookupClaudeSignIn,
  noteClaudeLoginEnded,
  noteClaudeLoginStarted,
  retainClaudeSignIn,
  parseClaudeMcpGet,
  runClaudeMcpGet,
  type ClaudeMcpGet,
} from "@/lib/providers/claude-signin-probe";

const URL_EL = "https://api.us.elevenlabs.io/v1/mcp";
const EL = { name: "elevenlabs", url: URL_EL };

/** `claude mcp get` as claude 2.1.282 prints it (piped, so no colour). */
const output = (status: string, url = URL_EL, extra = "") =>
  `elevenlabs:\n  Scope: User config (available in all your projects)\n  Status: ${status}\n${extra}  Type: http\n  URL: ${url}\n\nTo remove this server, run: claude mcp remove elevenlabs -s user\n`;

describe("parseClaudeMcpGet", () => {
  it("reads Connected as signed in and Needs authentication as not signed in, whatever mark comes first", () => {
    expect(parseClaudeMcpGet(output("✔ Connected"), URL_EL)).toBe("signed-in");
    expect(parseClaudeMcpGet(output("! Needs authentication"), URL_EL)).toBe("needs-sign-in");
    expect(parseClaudeMcpGet(output("Needs authentication"), URL_EL)).toBe("needs-sign-in");
    expect(parseClaudeMcpGet(output("✔ connected"), URL_EL)).toBe("signed-in");
  });

  it("anything else is no answer: a server it couldn't reach, a pending approval, no status line", () => {
    expect(parseClaudeMcpGet(output("✘ Failed to connect", URL_EL, "  Issue: ECONNREFUSED\n"), URL_EL)).toBe("unknown");
    expect(parseClaudeMcpGet(output("⏸ Pending approval"), URL_EL)).toBe("unknown");
    expect(parseClaudeMcpGet(output("✔ Connected, but something new"), URL_EL)).toBe("unknown");
    expect(parseClaudeMcpGet('No MCP server named "elevenlabs". Configured servers: other\n', URL_EL)).toBe("unknown");
    expect(parseClaudeMcpGet("", URL_EL)).toBe("unknown");
  });

  it("an answer about another server (a URL line naming a different url) is no answer for this entry", () => {
    expect(parseClaudeMcpGet(output("✔ Connected", "https://api.elevenlabs.io/v1/mcp"), URL_EL)).toBe("unknown");
  });
});

describe("lookupClaudeSignIn", () => {
  let clock = 1_000_000;
  const now = () => clock;
  /** An injected `mcp get` whose answers the case hands out one by one. */
  function fakeGet() {
    const pending: Array<(r: { ok: boolean; stdout: string }) => void> = [];
    const calls: string[] = [];
    const signals: AbortSignal[] = [];
    const get: ClaudeMcpGet = (name, signal) => {
      calls.push(name);
      signals.push(signal);
      return new Promise((resolve) => pending.push(resolve));
    };
    const answer = async (status: string, ok = true) => {
      pending.shift()!({ ok, stdout: output(status) });
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    return { get, calls, signals, answer };
  }
  const look = (f: ReturnType<typeof fakeGet>, extra: { revalidate?: boolean } = {}) => lookupClaudeSignIn(EL, { mcpGet: f.get, now, ...extra });

  beforeEach(() => {
    __resetClaudeSignInProbe();
    clock = 1_000_000;
  });
  afterEach(() => __resetClaudeSignInProbe());

  it("the first lookup starts ONE probe and says pending; the answer then stands for ten minutes", async () => {
    const f = fakeGet();
    expect(look(f)).toBe("pending");
    expect(look(f)).toBe("pending");
    expect(f.calls).toEqual(["elevenlabs"]);
    await f.answer("✔ Connected");
    expect(look(f)).toBe("signed-in");
    clock += CLAUDE_SIGNIN_MEMO_MS - 1;
    expect(look(f)).toBe("signed-in");
    expect(f.calls).toHaveLength(1);
  });

  it("an expired answer is asked again, and SERVED while it is: a signed-in row never reads pending again", async () => {
    const f = fakeGet();
    look(f);
    await f.answer("✔ Connected");
    clock += CLAUDE_SIGNIN_MEMO_MS;
    expect(look(f)).toBe("signed-in");
    expect(look(f)).toBe("signed-in");
    expect(f.calls).toHaveLength(2);
    await f.answer("! Needs authentication");
    expect(look(f)).toBe("needs-sign-in");
  });

  it("a failed or unreadable probe is remembered as unknown for a minute, not re-run on every poll", async () => {
    const f = fakeGet();
    look(f);
    await f.answer("✔ Connected", false);
    expect(look(f)).toBe("unknown");
    clock += CLAUDE_SIGNIN_UNKNOWN_MEMO_MS - 1;
    expect(look(f)).toBe("unknown");
    expect(f.calls).toHaveLength(1);
    clock += 1;
    expect(look(f)).toBe("unknown");
    expect(f.calls).toHaveLength(2);
  });

  it("a probe that throws is unknown", async () => {
    const get: ClaudeMcpGet = async () => {
      throw new Error("boom");
    };
    lookupClaudeSignIn(EL, { mcpGet: get, now });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(lookupClaudeSignIn(EL, { mcpGet: get, now })).toBe("unknown");
  });

  it("each entry, by name and url, has its own answer", async () => {
    const f = fakeGet();
    look(f);
    expect(lookupClaudeSignIn({ name: "elevenlabs", url: "https://other.example/mcp" }, { mcpGet: f.get, now })).toBe("pending");
    expect(f.calls).toHaveLength(2);
  });

  it("a clear (a setup terminal went away) asks again while serving the last answer; a probe from before it waits and is not kept", async () => {
    const f = fakeGet();
    look(f);
    await f.answer("✔ Connected");
    clock += 1_000;
    // Asked again after an earlier probe started but before it answered: never two at once, and its answer is old.
    __clearClaudeSignInMemo();
    expect(look(f)).toBe("signed-in");
    expect(f.calls).toHaveLength(2);
    __clearClaudeSignInMemo();
    expect(look(f)).toBe("signed-in");
    expect(f.calls).toHaveLength(2);
    await f.answer("! Needs authentication");
    expect(f.calls).toHaveLength(3);
    expect(look(f)).toBe("signed-in");
    await f.answer("✔ Connected");
    expect(look(f)).toBe("signed-in");
    expect(f.calls).toHaveLength(3);
  });

  it("never asks while the entry's mcp login may be running, and asks exactly once when it has ended", async () => {
    const f = fakeGet();
    noteClaudeLoginStarted("elevenlabs", "term-1", now);
    // Never answered, and its sign-in is running: unknown, not pending, and no probe.
    expect(look(f)).toBe("unknown");
    expect(look(f, { revalidate: true })).toBe("unknown");
    expect(f.calls).toEqual([]);
    noteClaudeLoginEnded("elevenlabs");
    expect(look(f)).toBe("pending");
    expect(look(f)).toBe("pending");
    expect(f.calls).toHaveLength(1);
    await f.answer("✔ Connected");
    expect(look(f)).toBe("signed-in");

    // A Sign in again: the last answer stands through it, and is asked again once after it.
    noteClaudeLoginStarted("elevenlabs", "term-1", now);
    clock += CLAUDE_SIGNIN_MEMO_MS;
    expect(look(f)).toBe("signed-in");
    expect(f.calls).toHaveLength(1);
    noteClaudeLoginEnded("elevenlabs");
    expect(look(f)).toBe("signed-in");
    expect(f.calls).toHaveLength(2);
  });

  it("a sign-in that starts while a probe for the entry runs stops that probe and drops its answer", async () => {
    const f = fakeGet();
    look(f);
    await f.answer("✔ Connected");
    clock += CLAUDE_SIGNIN_MEMO_MS;
    look(f);
    expect(f.calls).toHaveLength(2);
    expect(f.signals[1].aborted).toBe(false);
    noteClaudeLoginStarted("elevenlabs", "term-1", now);
    expect(f.signals[1].aborted).toBe(true);
    // Its 401 read from before the sign-in never becomes the answer.
    await f.answer("! Needs authentication");
    expect(look(f)).toBe("signed-in");
    noteClaudeLoginEnded("elevenlabs");
    look(f);
    expect(f.calls).toHaveLength(3);
    expect(f.signals[2].aborted).toBe(false);
  });

  it("a probe queued behind another never starts once the entry's sign-in has begun, and the one ahead is stopped too", async () => {
    const f = fakeGet();
    look(f);
    await f.answer("✔ Connected");
    clock += CLAUDE_SIGNIN_MEMO_MS;
    look(f); // A runs
    __clearClaudeSignInMemo();
    look(f); // B waits behind A
    expect(f.calls).toHaveLength(2);
    noteClaudeLoginStarted("elevenlabs", "term-1", now);
    expect(f.signals[1].aborted).toBe(true);
    await f.answer("! Needs authentication"); // A ends; B would start now
    expect(f.calls).toHaveLength(2);
    expect(look(f)).toBe("signed-in");
  });

  it("the terminal going away ends the sign-ins it was running, and only those", async () => {
    const f = fakeGet();
    noteClaudeLoginStarted("elevenlabs", "term-1", now);
    noteClaudeLoginStarted("higgsfield", "term-2", now);
    endClaudeLoginsOf("term-1");
    expect(look(f)).toBe("pending");
    expect(lookupClaudeSignIn({ name: "higgsfield", url: "https://mcp.higgsfield.ai/mcp" }, { mcpGet: f.get, now })).toBe("unknown");
    expect(f.calls).toEqual(["elevenlabs"]);
  });

  it("a start never followed by an end stops holding probes back after its bound", () => {
    const f = fakeGet();
    noteClaudeLoginStarted("elevenlabs", "term-1", now);
    clock += CLAUDE_LOGIN_MAX_MS;
    expect(look(f)).toBe("pending");
    expect(f.calls).toHaveLength(1);
  });

  it("revalidate (a look, or Retry) asks again about an answer that is not signed in and is at least 30 s old", async () => {
    const f = fakeGet();
    look(f);
    await f.answer("! Needs authentication");
    clock += CLAUDE_SIGNIN_REVALIDATE_AFTER_MS - 1;
    expect(look(f, { revalidate: true })).toBe("needs-sign-in");
    expect(f.calls).toHaveLength(1);
    clock += 1;
    expect(look(f, { revalidate: true })).toBe("needs-sign-in");
    expect(look(f, { revalidate: true })).toBe("needs-sign-in");
    expect(f.calls).toHaveLength(2);
    await f.answer("✔ Connected");
    // Signed in: a look does not ask again.
    clock += CLAUDE_SIGNIN_REVALIDATE_AFTER_MS;
    expect(look(f, { revalidate: true })).toBe("signed-in");
    expect(f.calls).toHaveLength(2);
  });

  it("forgets the answers of entries no longer in the config, so a re-added entry is asked afresh", async () => {
    const f = fakeGet();
    look(f);
    await f.answer("✔ Connected");
    retainClaudeSignIn([]);
    expect(look(f)).toBe("pending");
  });
});

describe("runClaudeMcpGet", () => {
  let dir: string;
  /** Processes a case started that must not outlive it (killed by pid, if still there). */
  let leftovers: number[];
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-claude-mcp-get-"));
    leftovers = [];
  });
  afterEach(async () => {
    for (const pid of leftovers) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    // Windows ends a killed process asynchronously, and a folder a live process has open can't be removed (EBUSY).
    for (const pid of leftovers) await goneWithin3s(pid);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  // The CLI is a small node script (`node <script> …args`), so every case runs the same on every host — a `/bin/sh`
  // body has no Windows. Process groups exist off Windows only: there the platform is pinned to linux, so macOS and
  // CI read the same; on Windows it is win32, where the product ends the CLI itself (`signalGroup` has no group to
  // reach what the CLI started — see the per-case notes).
  const WIN = process.platform === "win32";
  const PLATFORM: NodeJS.Platform = WIN ? "win32" : "linux";
  const cli = (body: string, args: string[] = []) => {
    const file = path.join(dir, `claude-${Math.random().toString(36).slice(2)}.js`);
    fs.writeFileSync(file, body);
    return { command: process.execPath, args: [file, ...args] };
  };
  const run = (body: string, args: string[] = [], timeoutMs?: number) =>
    runClaudeMcpGet(cli(body, args), { cwd: dir, platform: PLATFORM, timeoutMs });
  /** A CLI that starts a long-lived child of its own, writes both pids to `marker`, and never exits. */
  const hangingCli = (marker: string) => `
    const { spawn } = require("child_process");
    const fs = require("fs");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      stdio: "ignore", windowsHide: true, cwd: require("os").tmpdir(),
    });
    fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ cli: process.pid, child: child.pid }));
    setTimeout(() => {}, 30000);
  `;
  const isAlive = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  /** Polls until `pid` is gone; false when it is still there after 3 s. */
  const goneWithin3s = async (pid: number): Promise<boolean> => {
    const deadline = Date.now() + 3_000;
    while (isAlive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return !isAlive(pid);
  };
  const readPids = (marker: string): { cli: number; child: number } => {
    const pids = JSON.parse(fs.readFileSync(marker, "utf8")) as { cli: number; child: number };
    // The CLI is asserted gone; what it started may outlive it on Windows.
    leftovers.push(pids.child);
    return pids;
  };

  it("answers the CLI's stdout and whether it exited 0, run with the arguments given, in the folder given", async () => {
    const res = await run(
      `const fs = require("fs");
       console.log("cwd=" + fs.realpathSync(process.cwd()));
       console.log("args=" + process.argv.slice(2).join(" "));
       console.log("  Status: ✔ Connected");`,
      ["mcp", "get", "--", "elevenlabs"],
    );
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain(`cwd=${fs.realpathSync(dir)}`);
    expect(res.stdout).toContain("args=mcp get -- elevenlabs");
    expect(res.stdout).toContain("Status: ✔ Connected");
  });

  it("a non-zero exit is not ok", async () => {
    expect((await run('console.log("No MCP server named x"); process.exitCode = 1;')).ok).toBe(false);
  });

  it("a missing binary is not ok, and never throws", async () => {
    expect((await runClaudeMcpGet({ command: path.join(dir, "nope"), args: [] }, { cwd: dir, platform: PLATFORM })).ok).toBe(false);
  });

  it("a CLI that hangs is not ok once the bound passes, and its process group is killed", async () => {
    const marker = path.join(dir, "pids.json");
    const started = Date.now();
    const res = await run(hangingCli(marker), [], 1_000);
    expect(res.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
    const pids = readPids(marker);
    expect(await goneWithin3s(pids.cli)).toBe(true);
    // What the CLI started goes with it: SIGTERM, a 500 ms grace, then SIGKILL, to the whole group. Windows has no
    // process group to signal, so there libi's reach ends at the CLI itself.
    if (!WIN) expect(await goneWithin3s(pids.child)).toBe(true);
  });

  it("an abort (a sign-in started) answers at once and ends the CLI's whole process group", async () => {
    const marker = path.join(dir, "pids.json");
    const controller = new AbortController();
    const running = runClaudeMcpGet(cli(hangingCli(marker)), { cwd: dir, platform: PLATFORM, signal: controller.signal });
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(marker) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    const started = Date.now();
    controller.abort();
    expect((await running).ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(200);
    const pids = readPids(marker);
    expect(await goneWithin3s(pids.cli)).toBe(true);
    // As above: the group off Windows; the CLI alone on Windows.
    if (!WIN) expect(await goneWithin3s(pids.child)).toBe(true);
    // Aborted before it starts: nothing is spawned.
    const before = new AbortController();
    before.abort();
    const ran = path.join(dir, "ran");
    expect(
      await runClaudeMcpGet(cli(`require("fs").writeFileSync(${JSON.stringify(ran)}, "")`), { cwd: dir, platform: PLATFORM, signal: before.signal }),
    ).toEqual({ ok: false, stdout: "" });
    expect(fs.existsSync(ran)).toBe(false);
  });

  it("a CLI that exits but leaves something holding stdout open still answers what it printed", async () => {
    const marker = path.join(dir, "holder.pid");
    const started = Date.now();
    // The holder inherits the CLI's stdout. On Windows it must break away from the CLI's job object, which would
    // otherwise end it with the CLI (libuv's doing, not libi's) and the pipe would never be held.
    const res = await run(
      `const { spawn } = require("child_process");
       console.log("  Status: ! Needs authentication");
       const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
         stdio: ["ignore", "inherit", "ignore"], detached: ${WIN}, windowsHide: true, cwd: require("os").tmpdir(),
       });
       require("fs").writeFileSync(${JSON.stringify(marker)}, String(holder.pid));
       holder.unref();`,
      [],
      5_000,
    );
    leftovers.push(Number(fs.readFileSync(marker, "utf8")));
    expect(res.ok).toBe(true);
    expect(res.stdout).toContain("Needs authentication");
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});
