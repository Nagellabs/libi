// The two pieces of `lib/cli/connect-command.ts` that decide something rather
// than just printing it: which `mcp remove` undoes a given `mcp add`, and the
// one-shot "already exists" retry built on top of it.
//
// `libi connect` has to be re-runnable — the URL changes whenever the studio
// port does — so a duplicate server name is treated as "replace it", not as a
// failure. The stderr matched here is the real one, measured against Claude
// Code 2.1.245.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  makeRun,
  removeArgsFor,
  spawnShapeFor,
  type ExecFileLike,
} from "@/lib/cli/connect-command";
import { claudeMcpAddArgs, codexMcpAddArgs } from "@/lib/cli/connect";
import { listCodexConfigBackups } from "@/lib/codex-config/backup";

const ALREADY_EXISTS = "MCP server libi already exists in local config\n";
const URL = "http://127.0.0.1:3457/mcp";

/** A fake `execFile` that records every call and replays scripted outcomes.
 *  Anything past the end of the script succeeds silently. */
function fakeExecFile(script: Array<{ ok: boolean; stderr?: string }>) {
  const calls: Array<{ bin: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv }> = [];
  const impl: ExecFileLike = (bin, args, options, callback) => {
    const outcome = script[calls.length] ?? { ok: true };
    calls.push({ bin, args, cwd: options.cwd, env: options.env });
    // Real execFile is async; keep that so an accidental sync assumption in
    // the retry would show up here rather than in production.
    setTimeout(
      () =>
        callback(outcome.ok ? null : new Error("Command failed"), "", outcome.stderr ?? ""),
      0,
    );
  };
  return { impl, calls };
}

describe("removeArgsFor", () => {
  const cases: Array<{ name: string; add: string[]; expected: string[] }> = [
    {
      // `--global` → the add targeted `user`, so the removal must too;
      // removing from `local` would leave the colliding entry in place.
      name: "claude add --scope user removes from user",
      add: claudeMcpAddArgs(URL),
      expected: ["mcp", "remove", "--scope", "user", "libi"],
    },
    {
      // Claude Code's default scope is `local`. Naming it explicitly keeps the
      // removal in the scope the add actually collided with.
      name: "claude add with no scope removes from local",
      add: ["mcp", "add", "--transport", "http", "libi", URL],
      expected: ["mcp", "remove", "--scope", "local", "libi"],
    },
    {
      // Codex has no scopes at all (registrations are always user-wide) and
      // rejects `--scope`, so its removal carries just the name.
      name: "codex add removes with no scope flag",
      add: codexMcpAddArgs(URL),
      expected: ["mcp", "remove", "libi"],
    },
  ];

  for (const { name, add, expected } of cases) {
    it(name, () => {
      expect(removeArgsFor(add)).toEqual(expected);
    });
  }
});

describe("makeRun — the 'already exists' retry", () => {
  const addArgs = ["mcp", "add", "--transport", "http", "libi", URL];

  it("removes and re-adds when the first add reports a duplicate", async () => {
    const { impl, calls } = fakeExecFile([{ ok: false, stderr: ALREADY_EXISTS }]);
    const res = await makeRun(impl)("/usr/local/bin/claude", addArgs, "/proj");

    expect(res).toEqual({ ok: true, stderr: "" });
    expect(calls.map((c) => c.args)).toEqual([
      addArgs,
      ["mcp", "remove", "--scope", "local", "libi"],
      addArgs,
    ]);
    // Same binary, same cwd, all three times — a removal in another folder
    // would silently do nothing.
    expect(calls.every((c) => c.bin === "/usr/local/bin/claude" && c.cwd === "/proj")).toBe(true);
  });

  it("reports the ORIGINAL error when the removal fails too", async () => {
    const { impl, calls } = fakeExecFile([
      { ok: false, stderr: ALREADY_EXISTS },
      { ok: false, stderr: "no such server\n" },
    ]);
    const res = await makeRun(impl)("/usr/local/bin/claude", addArgs, "/proj");

    // The user must see the message that actually described their situation,
    // not the failure of libi's own recovery attempt.
    expect(res).toEqual({ ok: false, stderr: ALREADY_EXISTS });
    expect(calls).toHaveLength(2);
  });

  it("does not retry an unrelated failure", async () => {
    const { impl, calls } = fakeExecFile([{ ok: false, stderr: "not logged in\n" }]);
    const res = await makeRun(impl)("/usr/local/bin/claude", addArgs, "/proj");

    expect(res).toEqual({ ok: false, stderr: "not logged in\n" });
    expect(calls).toHaveLength(1);
  });

  it("does not retry a non-add command that happens to say 'already exists'", async () => {
    const removeArgs = ["mcp", "remove", "--scope", "local", "libi"];
    const { impl, calls } = fakeExecFile([{ ok: false, stderr: ALREADY_EXISTS }]);
    const res = await makeRun(impl)("/usr/local/bin/claude", removeArgs, "/proj");

    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("passes a successful add straight through, with one call", async () => {
    const { impl, calls } = fakeExecFile([]);
    const res = await makeRun(impl)("/usr/local/bin/codex", codexMcpAddArgs(URL), "/proj");

    expect(res).toEqual({ ok: true, stderr: "" });
    expect(calls).toHaveLength(1);
  });

  // The helper is not libi-specific: an add whose server is NOT libi must, on
  // retry, remove the name the add actually targeted — removing "libi" on a
  // `fal-ai` collision would delete the wrong entry.
  it("retries a non-libi add by removing the name the add targeted", async () => {
    const add = ["mcp", "add", "fal-ai", "--url", "https://mcp.fal.ai/mcp", "--bearer-token-env-var", "FAL_KEY"];
    const { impl, calls } = fakeExecFile([{ ok: false, stderr: "MCP server fal-ai already exists\n" }]);
    const res = await makeRun(impl)("/usr/local/bin/codex", add, "/proj");

    expect(res.ok).toBe(true);
    expect(calls.map((c) => c.args)).toEqual([add, ["mcp", "remove", "fal-ai"], add]);
  });

  it("derives the name past leading flags on a claude add", async () => {
    const add = ["mcp", "add", "--scope", "user", "--transport", "http", "fal-ai", URL];
    const { impl, calls } = fakeExecFile([{ ok: false, stderr: "MCP server fal-ai already exists in user config\n" }]);
    await makeRun(impl)("/usr/local/bin/claude", add, "/proj");

    expect(calls[1].args).toEqual(["mcp", "remove", "--scope", "user", "fal-ai"]);
  });

  // A codex call given a CODEX_HOME must reach that home, layered over the
  // process env so the child keeps PATH/HOME; a call with no env passes
  // nothing through and inherits as before.
  it("layers a caller env over process.env, and passes none when not given", async () => {
    const { impl, calls } = fakeExecFile([]);
    const run = makeRun(impl);
    await run("/usr/local/bin/codex", ["mcp", "remove", "x"], "/proj", { CODEX_HOME: "/scoped" });
    await run("/usr/local/bin/codex", ["mcp", "remove", "x"], "/proj");

    expect(calls[0].env?.CODEX_HOME).toBe("/scoped");
    expect(calls[0].env?.PATH).toBe(process.env.PATH);
    expect(calls[1].env).toBeUndefined();
  });
});

// `libi connect` reaches codex through this `run`, and codex re-serializes the
// WHOLE config.toml on any `mcp add` — dropping `args = []`, `120` → `120.0`,
// env reordered — with `mcp remove` not undoing it. libi keeps calling it
// (hand-editing that file is worse), so it takes a copy first and hands the
// path back for the CLI to print.
describe("makeRun backs up the codex config it is about to have rewritten", () => {
  let codexHome: string;

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-connect-codex-"));
    fs.writeFileSync(path.join(codexHome, "config.toml"), '[mcp_servers.node_repl]\nargs = []\n');
  });

  afterEach(() => {
    fs.rmSync(codexHome, { recursive: true, force: true });
  });

  it("copies before a codex mcp add and reports where", async () => {
    const { impl } = fakeExecFile([{ ok: true }]);
    const res = await makeRun(impl)("/Applications/ChatGPT.app/…/codex", codexMcpAddArgs(URL), "/tmp", {
      CODEX_HOME: codexHome,
    });
    expect(res.ok).toBe(true);
    expect(res.configBackup).toBeTruthy();
    expect(listCodexConfigBackups(codexHome)).toHaveLength(1);
  });

  it("takes ONE copy across the remove+re-add retry", async () => {
    // The 2nd and 3rd spawns rewrite a file codex itself just wrote; backing
    // those up too would bury the user's own version under codex's.
    const { impl, calls } = fakeExecFile([{ ok: false, stderr: ALREADY_EXISTS }, { ok: true }, { ok: true }]);
    await makeRun(impl)("/usr/local/bin/codex", codexMcpAddArgs(URL), "/tmp", {
      CODEX_HOME: codexHome,
    });
    expect(calls).toHaveLength(3);
    expect(listCodexConfigBackups(codexHome)).toHaveLength(1);
  });

  it("does not copy for claude, nor for a read-only codex subcommand", async () => {
    const { impl } = fakeExecFile([{ ok: true }, { ok: true }]);
    const run = makeRun(impl);
    await run("/usr/local/bin/claude", claudeMcpAddArgs(URL), "/tmp", { CODEX_HOME: codexHome });
    await run("/usr/local/bin/codex", ["mcp", "list"], "/tmp", { CODEX_HOME: codexHome });
    expect(listCodexConfigBackups(codexHome)).toHaveLength(0);
  });
});

// Windows QA 2026-09-11 (Node 22.20, claude-code 2.1.267 installed with
// `npm i -g`): the only claude on the machine was the npm shim
// `%APPDATA%\npm\claude.cmd`, and handing that to execFile fails with
// `spawn EINVAL` — Node refuses a .cmd/.bat since CVE-2024-27980. `libi connect`
// spawns through this `run`, so it must exec the shim's TARGET, the way the
// chat's CLI resolver already does.
describe("makeRun on Windows runs a .cmd shim's target, never the shim", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const pin = (p: NodeJS.Platform) => Object.defineProperty(process, "platform", { ...realPlatform, value: p });
  let dir: string;

  // Verbatim shape of the shims npm wrote on the Windows VM.
  const NATIVE_SHIM =
    '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n' +
    '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  const JS_SHIM =
    '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n)\r\n' +
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-connect-shim-"));
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", realPlatform);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("execs the native .exe a claude .cmd shim points at", async () => {
    pin("win32");
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, NATIVE_SHIM);
    const { impl, calls } = fakeExecFile([{ ok: true }]);
    const res = await makeRun(impl)(shim, claudeMcpAddArgs(URL), "/proj");
    expect(res.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].bin).not.toMatch(/\.cmd$/i);
    expect(calls[0].bin.endsWith("node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe")).toBe(true);
    expect(calls[0].args).toEqual(claudeMcpAddArgs(URL));
  });

  it("runs a JS .cmd shim's script through node, args after the script", async () => {
    pin("win32");
    const shim = path.join(dir, "codex.cmd");
    fs.writeFileSync(shim, JS_SHIM);
    const { impl, calls } = fakeExecFile([{ ok: true }]);
    await makeRun(impl)(shim, ["mcp", "list"], "/proj");
    expect(calls[0].bin).not.toMatch(/\.cmd$/i);
    expect(calls[0].args[0]).toMatch(/codex\.js$/);
    expect(calls[0].args.slice(1)).toEqual(["mcp", "list"]);
  });

  it("the remove+re-add retry execs the target on every spawn", async () => {
    pin("win32");
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, NATIVE_SHIM);
    const { impl, calls } = fakeExecFile([{ ok: false, stderr: ALREADY_EXISTS }, { ok: true }, { ok: true }]);
    await makeRun(impl)(shim, claudeMcpAddArgs(URL), "/proj");
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.bin).toMatch(/claude\.exe$/);
  });

  it("leaves a native .exe, and every path off Windows, untouched", () => {
    pin("win32");
    expect(spawnShapeFor("C:\\Users\\u\\.local\\bin\\claude.exe")).toEqual({
      command: "C:\\Users\\u\\.local\\bin\\claude.exe",
      args: [],
    });
    pin("linux");
    expect(spawnShapeFor("/opt/tools/claude.cmd")).toEqual({ command: "/opt/tools/claude.cmd", args: [] });
  });

  it("passes a shim of an unknown shape through unchanged (no worse than before)", () => {
    pin("win32");
    const shim = path.join(dir, "claude.cmd");
    fs.writeFileSync(shim, "@echo off\r\nsomething-else %*\r\n");
    expect(spawnShapeFor(shim)).toEqual({ command: shim, args: [] });
  });
});

describe("connectCommand output", () => {
  it("prints one line per install and where to manage them", async () => {
    vi.resetModules();
    vi.doMock("@/lib/agents/cli/resolve", () => ({ resolveAgentCli: async () => null }));
    vi.doMock("@/mcp/skills/installs", () => ({
      addSkillInstall: async (input: { agentId: string; scope: string; folderPath?: string }) => ({
        id: "x", agentId: input.agentId, scope: input.scope, folderPath: input.folderPath ?? null, source: "cli", status: "up-to-date", error: null,
        skippedNames: [], installedCount: 30, lastSyncedAt: null,
        path: `${input.folderPath}/${input.agentId === "codex" ? ".agents" : ".claude"}/skills`,
      }),
      listSkillInstalls: async () => [],
      SkillInstallError: class extends Error { constructor(readonly code: string, m: string) { super(m); this.name = "SkillInstallError"; } },
    }));
    vi.doMock("@/lib/analytics/server", () => ({ trackServerEvent: () => {} }));
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    // A scratch LIBI_HOME: the command reads `<LIBI_HOME>/mcp-port`, and that must never be the real ~/.libi.
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "connect-cmd-"));
    vi.stubEnv("LIBI_HOME", scratchHome);
    try {
      const { connectCommand } = await import("@/lib/cli/connect-command");
      process.env.LIBI_LAUNCH_CWD = "/me/proj";
      await connectCommand(undefined, {});
    } finally {
      write.mockRestore();
      delete process.env.LIBI_LAUNCH_CWD;
      vi.unstubAllEnvs();
      fs.rmSync(scratchHome, { recursive: true, force: true });
      vi.doUnmock("@/mcp/skills/installs");
      vi.doUnmock("@/lib/agents/cli/resolve");
      vi.doUnmock("@/lib/analytics/server");
    }
    const text = out.join("");
    expect(text).toContain("[libi] ✓ Claude Code skills: 30 skills in /me/proj/.claude/skills\n");
    expect(text).toContain("[libi] ✓ Codex skills: 30 skills in /me/proj/.agents/skills\n");
    expect(text).toContain("[libi] Manage these on Agents → Global setup in libi.\n");
    expect(text).toContain("claude mcp add --transport http --scope user libi ");
  });

  // A `skipped` step is `id: "skills"` only for the agent that's already
  // installed for every folder — `connectCommand`'s print loop drops every
  // OTHER skipped step (e.g. `legacy`) but must still print this one, since
  // it is the only place the user learns why nothing changed for that agent.
  it("prints a skipped skills step (an agent already installed for every folder)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/agents/cli/resolve", () => ({ resolveAgentCli: async () => null }));
    vi.doMock("@/mcp/skills/installs", () => ({
      addSkillInstall: async (input: { agentId: string; scope: string; folderPath?: string }) => {
        if (input.agentId === "claude-code") {
          throw new (class extends Error {
            constructor(readonly code: string, m: string) {
              super(m);
              this.name = "SkillInstallError";
            }
          })("user_level_installed", "Skills are installed for every folder, so every folder already has them.");
        }
        return {
          id: "x", agentId: input.agentId, scope: input.scope, folderPath: input.folderPath ?? null, source: "cli", status: "up-to-date", error: null,
          skippedNames: [], installedCount: 30, lastSyncedAt: null,
          path: `${input.folderPath}/.agents/skills`,
        };
      },
      listSkillInstalls: async () => [],
      SkillInstallError: class extends Error { constructor(readonly code: string, m: string) { super(m); this.name = "SkillInstallError"; } },
    }));
    vi.doMock("@/lib/analytics/server", () => ({ trackServerEvent: () => {} }));
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "connect-cmd-"));
    vi.stubEnv("LIBI_HOME", scratchHome);
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const { connectCommand } = await import("@/lib/cli/connect-command");
      process.env.LIBI_LAUNCH_CWD = "/me/proj";
      await connectCommand(undefined, {});
    } finally {
      write.mockRestore();
      delete process.env.LIBI_LAUNCH_CWD;
      vi.unstubAllEnvs();
      fs.rmSync(scratchHome, { recursive: true, force: true });
      vi.doUnmock("@/mcp/skills/installs");
      vi.doUnmock("@/lib/agents/cli/resolve");
      vi.doUnmock("@/lib/analytics/server");
    }
    const text = out.join("");
    expect(text).toContain(
      "[libi] → Claude Code skills: not installed here — Skills are installed for every folder, so every folder already has them.\n",
    );
    expect(text).toContain("[libi] ✓ Codex skills: 30 skills in /me/proj/.agents/skills\n");
    // `user_level_installed` is the one-level-per-agent skip: a normal skip,
    // never a failure — the run still exits 0.
    expect(process.exitCode).toBe(undefined);
    process.exitCode = originalExitCode;
  });

  // A skills install that failed outright (no migrated DB yet) is not a
  // skip: nothing was installed, so the run exits 1 like a refused install.
  it("exits 1 when a skills install fails outright (no migrated DB)", async () => {
    vi.resetModules();
    vi.doMock("@/lib/agents/cli/resolve", () => ({ resolveAgentCli: async () => null }));
    vi.doMock("@/mcp/skills/installs", () => ({
      addSkillInstall: async () => {
        throw new Error("no such table: skill_installs");
      },
      listSkillInstalls: async () => [],
      SkillInstallError: class extends Error { constructor(readonly code: string, m: string) { super(m); this.name = "SkillInstallError"; } },
    }));
    vi.doMock("@/lib/analytics/server", () => ({ trackServerEvent: () => {} }));
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "connect-cmd-"));
    vi.stubEnv("LIBI_HOME", scratchHome);
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    let exitCode: typeof process.exitCode;
    try {
      const { connectCommand } = await import("@/lib/cli/connect-command");
      process.env.LIBI_LAUNCH_CWD = "/me/proj";
      await connectCommand(undefined, {});
      exitCode = process.exitCode;
    } finally {
      write.mockRestore();
      delete process.env.LIBI_LAUNCH_CWD;
      vi.unstubAllEnvs();
      fs.rmSync(scratchHome, { recursive: true, force: true });
      vi.doUnmock("@/mcp/skills/installs");
      vi.doUnmock("@/lib/agents/cli/resolve");
      vi.doUnmock("@/lib/analytics/server");
      process.exitCode = originalExitCode;
    }
    const text = out.join("");
    expect(text).toContain("Claude Code skills: could not install (no such table: skill_installs) — start libi once, then re-run libi connect\n");
    expect(text).toContain("Codex skills: could not install (no such table: skill_installs) — start libi once, then re-run libi connect\n");
    expect(exitCode).toBe(1);
  });

  // A refused or failed skills install must fail the whole run, even though
  // every step is "handled" (printed) rather than thrown — otherwise a
  // script or CI reading the exit code alone would see success.
  it("exits 1 when a skills install is refused by validation", async () => {
    vi.resetModules();
    vi.doMock("@/lib/agents/cli/resolve", () => ({ resolveAgentCli: async () => null }));
    vi.doMock("@/mcp/skills/installs", () => ({
      addSkillInstall: async (input: { agentId: string; scope: string; folderPath?: string }) => {
        if (input.agentId === "claude-code") {
          throw new (class extends Error {
            constructor(readonly code: string, m: string) {
              super(m);
              this.name = "SkillInstallError";
            }
          })("refused_home", "That's your home folder. To install libi's skills for every folder, choose Every folder.");
        }
        return {
          id: "x", agentId: input.agentId, scope: input.scope, folderPath: input.folderPath ?? null, source: "cli", status: "up-to-date", error: null,
          skippedNames: [], installedCount: 30, lastSyncedAt: null,
          path: `${input.folderPath}/.agents/skills`,
        };
      },
      listSkillInstalls: async () => [],
      SkillInstallError: class extends Error { constructor(readonly code: string, m: string) { super(m); this.name = "SkillInstallError"; } },
    }));
    vi.doMock("@/lib/analytics/server", () => ({ trackServerEvent: () => {} }));
    const out: string[] = [];
    const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => { out.push(String(chunk)); return true; });
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "connect-cmd-"));
    vi.stubEnv("LIBI_HOME", scratchHome);
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const { connectCommand } = await import("@/lib/cli/connect-command");
      process.env.LIBI_LAUNCH_CWD = "/home/me";
      await connectCommand(undefined, {});
      // Registration steps keep their current exit semantics: both CLIs are
      // unresolved here (`resolveAgentCli` mocked to `null`) and that alone
      // must not be why the run failed.
      expect(process.exitCode).toBe(1);
    } finally {
      write.mockRestore();
      delete process.env.LIBI_LAUNCH_CWD;
      vi.unstubAllEnvs();
      fs.rmSync(scratchHome, { recursive: true, force: true });
      vi.doUnmock("@/mcp/skills/installs");
      vi.doUnmock("@/lib/agents/cli/resolve");
      vi.doUnmock("@/lib/analytics/server");
      process.exitCode = originalExitCode;
    }
    const text = out.join("");
    // The CLI's own line — not the service's "choose Every folder" message
    // with a "Use --global" hint appended.
    expect(text).toContain(
      "[libi] → Claude Code skills: That's your home folder — run libi connect --global to install libi's skills for every folder.\n",
    );
    expect(text).not.toContain("choose Every folder");
    expect(text).toContain("[libi] ✓ Codex skills: 30 skills in /home/me/.agents/skills\n");
  });
});
