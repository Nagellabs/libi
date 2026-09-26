// Read-only detection of the MCP servers the user's agents already have
// (lib/providers/detect.ts). Every case runs against temp files and an
// injected codex exec — the user's real ~/.claude.json and ~/.codex are never
// touched. The two invariants that matter most: absent / malformed input
// contributes nothing and never throws, and no key VALUE ever appears in the
// result.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectProviders, __clearProviderMemo, __resetLauncherStatusLog, type DetectDeps } from "@/lib/providers/detect";
import type { LauncherDeps } from "@/lib/providers/launcher";
import { serverLogger } from "@/lib/logger";

/**
 * The launcher lookup pinned away from the host: no login-shell PATH known and an empty process PATH, so every bare
 * command is `unknown` and leaves its row as it was. The cases that are not about launchers must not flip on a dev
 * machine that has (or lacks) `uvx`, or whose resolver has already probed its login shell. A case that passes its
 * own `launcher` replaces this.
 */
const HOST_FREE_LAUNCHER: LauncherDeps = { platform: "linux", loginShellDirs: () => null, processPathDirs: () => [], isExecutable: () => false };
// `??`, not a spread default: a case passing `launcher: undefined` explicitly must still get the host-free one.
const detect = (deps: DetectDeps) => detectProviders({ ...deps, launcher: deps.launcher ?? HOST_FREE_LAUNCHER });
/** The rows alone; the cases that are about whether Codex's rows are a fresh answer read `detect` whole. */
const detectRows = async (deps: DetectDeps) => (await detect(deps)).connected;

// A script CLI runs through libi's node; pin which node that is so the spawned command is assertable.
vi.mock("@/lib/runtime/node-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runtime/node-runtime")>()),
  resolveNodeCommand: () => "/managed/bin/node",
}));

let home: string;
let claudeConfigPath: string;
let agentDir: string;

const noCodex = async () => ({ ok: false as const, stderr: "codex: command not found" });
const NATIVE = { path: "/usr/local/bin/codex", realPath: "/fixture/real/codex", execPath: "/fixture/exec/codex", version: "0.160.0", meetsMinimum: true as const };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-detect-"));
  claudeConfigPath = path.join(home, ".claude.json");
  agentDir = path.join(home, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  __clearProviderMemo();
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  __clearProviderMemo();
});

describe("detectProviders — Claude", () => {
  it("returns nothing when ~/.claude.json is missing", async () => {
    expect(await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex })).toEqual([]);
  });

  it("survives malformed JSON", async () => {
    fs.writeFileSync(claudeConfigPath, "{not json");
    expect(await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex })).toEqual([]);
  });

  it("maps a user-scope HTTP fal entry with an auth header to connected", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: {
        "fal-ai": { type: "http", url: "https://mcp.fal.ai/mcp", headers: { Authorization: "Bearer sk-x" } },
      },
    }));
    const out = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex });
    expect(out).toEqual([
      { agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" },
    ]);
  });

  it("reports needs-key when an HTTP entry has no auth header", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { "fal-ai": { type: "http", url: "https://mcp.fal.ai/mcp" } },
    }));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex });
    expect(row.status).toBe("needs-key");
  });

  it("matches a stdio ElevenLabs entry by name, case-insensitively", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { ElevenLabs: { command: "uvx", args: ["elevenlabs-mcp"], env: { ELEVENLABS_API_KEY: "k" } } },
    }));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex });
    expect(row).toEqual({
      agent: "claude", name: "ElevenLabs", providerId: "elevenlabs", transport: "stdio", status: "connected", scope: "user",
    });
  });

  it("matches by URL host when the name is unfamiliar", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { "my-images": { type: "http", url: "https://mcp.fal.ai/mcp", headers: { Authorization: "Bearer k" } } },
    }));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex });
    expect(row.providerId).toBe("fal");
  });

  it("also reads the libi agent dir's project scope and its .mcp.json", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: {},
      projects: { [agentDir]: { mcpServers: { "fal-ai": { type: "http", url: "https://mcp.fal.ai/mcp", headers: { Authorization: "Bearer k" } } } } },
    }));
    fs.writeFileSync(path.join(agentDir, ".mcp.json"), JSON.stringify({
      mcpServers: { other: { command: "node", args: ["x.js"] } },
    }));
    const names = (await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex })).map((r) => r.name);
    expect(names.sort()).toEqual(["fal-ai", "other"]);
  });

  // `remove` sends `claude mcp remove --scope <scope>`, and Claude Code refuses
  // a name that lives in another scope — so every Claude row carries the scope
  // it was read from. Codex has no scopes; its rows carry no key at all.
  it("tags each Claude row with the scope it was read from; codex rows carry none", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { "u-srv": { type: "http", url: "http://127.0.0.1:9/u" } },
      projects: { [agentDir]: { mcpServers: { "l-srv": { type: "http", url: "http://127.0.0.1:9/l" } } } },
    }));
    fs.writeFileSync(path.join(agentDir, ".mcp.json"), JSON.stringify({
      mcpServers: { "p-srv": { command: "node", args: ["x.js"] } },
    }));
    const out = await detectRows({
      claudeConfigPath, agentDir,
      codexExec: async () => ({ ok: true as const, stdout: JSON.stringify([
        { name: "c-srv", enabled: true, transport: { type: "streamable_http", url: "http://127.0.0.1:9/c" } },
      ]) }),
    });
    const scopes = Object.fromEntries(out.map((r) => [r.name, r.scope]));
    expect(scopes).toEqual({ "u-srv": "user", "l-srv": "local", "p-srv": "project", "c-srv": undefined });
    expect("scope" in out.find((r) => r.name === "c-srv")!).toBe(false);
  });

  it("returns an unmatched server with providerId null", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { "my-thing": { command: "node", args: ["s.js"] } },
    }));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex });
    expect(row.providerId).toBeNull();
    expect(row.status).toBe("connected");
  });

  it("drops libi's own entries", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: {
        libi: { type: "http", url: "http://127.0.0.1:3457/mcp" },
        "libi-app": { type: "http", url: "http://127.0.0.1:3457/mcp" },
      },
    }));
    expect(await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex })).toEqual([]);
  });

  // Higgsfield signs in with the user's account (OAuth). Claude keeps that sign-in
  // outside its config, and detection deliberately never runs `claude mcp get` to
  // ask (it writes Claude's needs-auth cache and makes a network round trip), so
  // the row is Connected with its sign-in unknown — never Needs key.
  it("a Higgsfield entry is never needs-key: connected, with its sign-in unknown", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { higgsfield: { type: "http", url: "https://mcp.higgsfield.ai/mcp" } },
    }));
    expect(await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex })).toEqual([
      { agent: "claude", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "connected", signIn: "unknown", scope: "user" },
    ]);
  });

  it("matches Higgsfield by URL in the local scope; an entry carrying its own Authorization header is simply connected", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      projects: { [agentDir]: { mcpServers: {
        "my-hf": { type: "http", url: "https://mcp.higgsfield.ai/mcp" },
        "hf-token": { type: "http", url: "https://mcp.higgsfield.ai/mcp", headers: { Authorization: "Bearer hf-secret-value" } },
      } } },
    }));
    const out = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex });
    expect(out).toEqual([
      { agent: "claude", name: "my-hf", providerId: "higgsfield", transport: "http", status: "connected", signIn: "unknown", scope: "local" },
      { agent: "claude", name: "hf-token", providerId: "higgsfield", transport: "http", status: "connected", scope: "local" },
    ]);
    expect(JSON.stringify(out)).not.toContain("hf-secret-value");
  });

  it("dedupes a server that appears in both user and project scope", async () => {
    const entry = { type: "http", url: "https://mcp.fal.ai/mcp", headers: { Authorization: "Bearer k" } };
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { "fal-ai": entry },
      projects: { [agentDir]: { mcpServers: { "fal-ai": entry } } },
    }));
    expect(await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex })).toHaveLength(1);
  });
});

describe("detectProviders — Codex", () => {
  const listing = JSON.stringify([
    { name: "fal-ai", enabled: true, transport: { type: "streamable_http", url: "https://mcp.fal.ai/mcp", bearer_token_env_var: "FAL_KEY" }, auth_status: "ok" },
    { name: "elevenlabs", enabled: false, transport: { type: "stdio", command: "uvx", env: { ELEVENLABS_API_KEY: "k" } }, auth_status: "ok" },
    { name: "libi", enabled: true, transport: { type: "streamable_http", url: "http://127.0.0.1:3457/mcp?agent=codex" }, auth_status: "ok" },
  ]);

  it("maps entries and drops libi's own", async () => {
    const out = await detectRows({
      claudeConfigPath, agentDir,
      codexExec: async () => ({ ok: true as const, stdout: listing }),
    });
    expect(out).toEqual([
      { agent: "codex", name: "fal-ai", providerId: "fal", transport: "http", status: "connected" },
      { agent: "codex", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "disabled" },
    ]);
  });

  it("asks codex for exactly `mcp list --json`", async () => {
    const seen: string[][] = [];
    await detectRows({
      claudeConfigPath, agentDir,
      codexExec: async (args) => { seen.push(args); return { ok: true as const, stdout: "[]" }; },
    });
    expect(seen).toEqual([["mcp", "list", "--json"]]);
  });

  it("reports needs-key for an HTTP entry with no bearer var", async () => {
    const [row] = await detectRows({
      claudeConfigPath, agentDir,
      codexExec: async () => ({ ok: true as const, stdout: JSON.stringify([
        { name: "fal-ai", enabled: true, transport: { type: "streamable_http", url: "https://mcp.fal.ai/mcp" }, auth_status: "ok" },
      ]) }),
    });
    expect(row.status).toBe("needs-key");
  });

  // `auth_status` values: codex's McpAuthStatus variants in snake_case. `not_logged_in`,
  // `bearer_token` and `unsupported` were printed by a real codex-cli 0.153.4 against a
  // scratch CODEX_HOME; `o_auth` is the OAuth variant's snake_case (only a real sign-in shows it).
  const higgsfieldEntry = (auth_status: string | undefined) => ({
    name: "higgsfield",
    enabled: true,
    transport: { type: "streamable_http", url: "https://mcp.higgsfield.ai/mcp", bearer_token_env_var: null },
    auth_status,
  });
  it.each([
    ["not_logged_in", { status: "needs-sign-in" }],
    ["o_auth", { status: "connected" }],
    ["oauth", { status: "connected" }],
    ["bearer_token", { status: "connected" }],
    ["unknown", { status: "connected", signIn: "unknown" }],
    ["unsupported", { status: "connected", signIn: "unknown" }],
    [undefined, { status: "connected", signIn: "unknown" }],
  ] as const)("a Higgsfield entry with auth_status %s is never needs-key", async (authStatus, expected) => {
    const out = await detectRows({
      claudeConfigPath, agentDir,
      codexExec: async () => ({ ok: true as const, stdout: JSON.stringify([higgsfieldEntry(authStatus)]) }),
    });
    expect(out).toEqual([{ agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", ...expected }]);
  });

  it("a disabled Higgsfield entry is disabled whatever codex says about its sign-in", async () => {
    const [row] = await detectRows({
      claudeConfigPath, agentDir,
      codexExec: async () => ({ ok: true as const, stdout: JSON.stringify([{ ...higgsfieldEntry("not_logged_in"), enabled: false }]) }),
    });
    expect(row).toEqual({ agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "disabled" });
  });

  it("auth_status changes nothing for a keyed provider: fal with no bearer var still needs its key", async () => {
    const out = await detectRows({
      claudeConfigPath, agentDir,
      codexExec: async () => ({ ok: true as const, stdout: JSON.stringify([
        { name: "fal-ai", enabled: true, transport: { type: "streamable_http", url: "https://mcp.fal.ai/mcp" }, auth_status: "not_logged_in" },
        { name: "fal", enabled: true, transport: { type: "streamable_http", url: "https://mcp.fal.ai/mcp", bearer_token_env_var: "FAL_KEY" }, auth_status: "not_logged_in" },
      ]) }),
    });
    expect(out.map((r) => r.status)).toEqual(["needs-key", "connected"]);
    expect(out.every((r) => !("signIn" in r))).toBe(true);
  });

  it("contributes nothing when codex is absent, and never throws", async () => {
    expect(await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex })).toEqual([]);
  });

  it("output that is not a listing is no information, never an empty listing: no Codex rows, and codex says unread", async () => {
    expect(await detect({
      claudeConfigPath, agentDir,
      codexExec: async () => ({ ok: true as const, stdout: "not json" }),
    })).toEqual({ connected: [], codex: "unread" });
    expect(await detect({ claudeConfigPath, agentDir, resolveCodex: async () => NATIVE, codexList: async () => null }))
      .toEqual({ connected: [], codex: "unread" });
    // A real empty listing, and no codex at all, are answers.
    expect(await detect({ claudeConfigPath, agentDir, codexExec: async () => ({ ok: true as const, stdout: "[]" }) }))
      .toEqual({ connected: [] });
    expect(await detect({ claudeConfigPath, agentDir, resolveCodex: async () => null, codexList: async () => [] }))
      .toEqual({ connected: [] });
  });

  it("contributes nothing on unparseable output", async () => {
    expect(await detectRows({
      claudeConfigPath, agentDir,
      codexExec: async () => ({ ok: true as const, stdout: "not json" }),
    })).toEqual([]);
  });

  it("skips malformed entries without dropping the good ones", async () => {
    const out = await detectRows({
      claudeConfigPath, agentDir,
      codexExec: async () => ({ ok: true as const, stdout: JSON.stringify([
        null, 42, { enabled: true }, { name: "fal-ai", enabled: true, transport: { type: "streamable_http", url: "https://mcp.fal.ai/mcp", bearer_token_env_var: "FAL_KEY" } },
      ]) }),
    });
    expect(out.map((r) => r.name)).toEqual(["fal-ai"]);
  });

  // The resolver ran `--version` through the spawn shape of the realPath (node for a
  // script, the JS target for a Windows .cmd); listing must run the SAME command, or a
  // CLI the resolver proved working reads as "could not ask".
  const falListing = [{ name: "fal", enabled: true, transport: { type: "streamable_http", url: "https://mcp.fal.ai/mcp", bearer_token_env_var: "FAL_KEY" } }];

  it("lists a native codex as its realPath — not the PATH hit, not execPath", async () => {
    const codexList = vi.fn(async () => falListing);
    const out = await detectRows({
      claudeConfigPath, agentDir,
      resolveCodex: async () => ({ path: "/usr/local/bin/codex", realPath: "/fixture/real/codex", execPath: "/fixture/exec/codex", version: "0.160.0", meetsMinimum: true }),
      codexList,
    });
    expect(out.filter((r) => r.agent === "codex")).toHaveLength(1);
    expect(codexList).toHaveBeenCalledTimes(1);
    expect(codexList).toHaveBeenCalledWith({ command: "/fixture/real/codex", args: [] });
  });

  it("lists a script codex through node, the way the resolver ran it", async () => {
    const codexList = vi.fn(async () => falListing);
    await detectRows({
      claudeConfigPath, agentDir,
      resolveCodex: async () => ({ path: "/usr/local/bin/codex", realPath: "/fixture/lib/codex/bin/codex.js", execPath: "/fixture/exec/codex", version: "0.160.0", meetsMinimum: true }),
      codexList,
    });
    expect(codexList).toHaveBeenCalledWith({ command: "/managed/bin/node", args: ["/fixture/lib/codex/bin/codex.js"] });
  });

  it("no resolved codex contributes no rows and never lists", async () => {
    const codexList = vi.fn(async () => []);
    const out = await detectRows({ claudeConfigPath, agentDir, resolveCodex: async () => null, codexList });
    expect(out.filter((r) => r.agent === "codex")).toEqual([]);
    expect(codexList).not.toHaveBeenCalled();
  });

  it("never returns a key value", async () => {
    const out = await detectRows({
      claudeConfigPath, agentDir,
      codexExec: async () => ({ ok: true as const, stdout: listing }),
    });
    expect(JSON.stringify(out)).not.toContain("FAL_KEY");
    expect(JSON.stringify(out)).not.toMatch(/"k"/);
  });
});

describe("detectProviders — memo", () => {
  it("does not serve or fill the memo for a call with injected deps", async () => {
    let calls = 0;
    const exec = async () => { calls++; return { ok: true as const, stdout: "[]" }; };
    await detectRows({ claudeConfigPath, agentDir, codexExec: exec });
    await detectRows({ claudeConfigPath, agentDir, codexExec: exec });
    expect(calls).toBe(2);
  });
});

// A local (stdio) entry is only as good as its launcher: Claude Code logged `Executable not found in $PATH: uvx`
// for an ElevenLabs entry libi had called connected, and the chat simply had no ElevenLabs tools. Detection now
// says `cant-start`, naming the bare command only, when the launcher can't be found — and says nothing new when it
// can't tell (no login-shell PATH known yet). Every case pins the platform and the folders searched.
describe("detectProviders — a local server whose launcher is missing", () => {
  let bin: string;
  beforeEach(() => {
    bin = path.join(home, "bin");
    fs.mkdirSync(bin);
    __resetLauncherStatusLog();
  });

  /** POSIX lookup: the login-shell PATH is `bin` (or unknown), nothing else is searched. */
  const posix = (over: Partial<LauncherDeps> = {}): LauncherDeps => ({
    platform: "linux",
    loginShellDirs: () => [bin],
    processPathDirs: () => [],
    ...over,
  });
  const elevenlabs = (command: string, env: Record<string, string> = { ELEVENLABS_API_KEY: "secret-el-key" }) =>
    JSON.stringify({ mcpServers: { elevenlabs: { command, args: ["elevenlabs-mcp"], env } } });
  const install = (name: string) => {
    const file = path.join(bin, name);
    fs.writeFileSync(file, "#!/bin/sh\n");
    fs.chmodSync(file, 0o755);
    return file;
  };

  it("a bare command on no folder of the known login-shell PATH: cant-start, naming the command only", async () => {
    fs.writeFileSync(claudeConfigPath, elevenlabs("uvx"));
    const out = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix() });
    expect(out).toEqual([
      { agent: "claude", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "cant-start", missingCommand: "uvx", scope: "user" },
    ]);
    // Never an argument, never an env value.
    expect(JSON.stringify(out)).not.toContain("elevenlabs-mcp");
    expect(JSON.stringify(out)).not.toContain("secret-el-key");
  });

  it("an absolute command that is not there: cant-start with the bare name, not the folder", async () => {
    // A POSIX absolute path, because the lookup is pinned to linux: the host's `path.join(home, …)` is `C:\…` on
    // Windows, which POSIX reads as a bare name. The folder is unique and never created.
    const gone = `/libi-detect-test-${process.pid}-${Date.now()}`;
    fs.writeFileSync(claudeConfigPath, elevenlabs(`${gone}/uvx`));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix({ loginShellDirs: () => null }) });
    expect(row).toMatchObject({ status: "cant-start", missingCommand: "uvx" });
    expect(JSON.stringify(row)).not.toContain(gone);
  });

  it("a bare command found on the login-shell PATH: the row reads as it always did", async () => {
    install("uvx");
    fs.writeFileSync(claudeConfigPath, elevenlabs("uvx"));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix() });
    expect(row).toEqual({ agent: "claude", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "connected", scope: "user" });
  });

  // A running Codex process keeps the PATH it started with (lib/agents/agent-path.ts): a launcher installed since is
  // on the login shell's PATH, where the lookup finds it, but not on that process's, so its chats can't start it.
  it("a Codex local entry whose launcher is on none of the running Codex process's folders reads launcherAfterStart", async () => {
    install("uvx");
    const codexExec = async () => ({ ok: true as const, stdout: JSON.stringify([
      { name: "elevenlabs", enabled: true, transport: { type: "stdio", command: "uvx", args: ["elevenlabs-mcp"], env: { ELEVENLABS_API_KEY: "k" } } },
    ]) });
    const rows = (agentPathDirs: DetectDeps["agentPathDirs"]) => detectRows({ claudeConfigPath, agentDir, codexExec, launcher: posix(), agentPathDirs });
    expect(await rows(() => ["/usr/bin"])).toEqual([
      { agent: "codex", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "connected", launcherAfterStart: true },
    ]);
    // The process has the folder, or none runs (the next one gets the login shell's PATH): as it always read.
    expect((await rows(() => [bin]))[0]).not.toHaveProperty("launcherAfterStart");
    expect((await rows(() => null))[0]).not.toHaveProperty("launcherAfterStart");
  });

  it("a Claude Code local entry never reads launcherAfterStart: each new Claude chat gets the login shell's PATH", async () => {
    install("uvx");
    fs.writeFileSync(claudeConfigPath, elevenlabs("uvx"));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix(), agentPathDirs: () => ["/usr/bin"] });
    expect(row).toEqual({ agent: "claude", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "connected", scope: "user" });
  });

  it("no login-shell PATH known yet: unknown is not broken, so the row reads as it always did", async () => {
    fs.writeFileSync(claudeConfigPath, elevenlabs("uvx"));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix({ loginShellDirs: () => null }) });
    expect(row.status).toBe("connected");
    expect("missingCommand" in row).toBe(false);
  });

  // A keyed catalog provider (fal) run as a local server with no key: the one shape that reads needs-key
  // whatever transport the catalog lists for ElevenLabs.
  it("a missing launcher beats a missing key: it is the first thing to fix", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({ mcpServers: { "fal-ai": { command: "uvx", args: ["fal-mcp"] } } }));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix() });
    expect(row).toMatchObject({ status: "cant-start", missingCommand: "uvx" });
    // With the launcher there, the missing key is what is left.
    install("uvx");
    const [again] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix() });
    expect(again.status).toBe("needs-key");
  });

  it("a server libi doesn't recognise can't start either", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({ mcpServers: { "my-thing": { command: "my-launcher" } } }));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix() });
    expect(row).toEqual({ agent: "claude", name: "my-thing", providerId: null, transport: "stdio", status: "cant-start", missingCommand: "my-launcher", scope: "user" });
  });

  it("an HTTP row is never looked up, whatever it carries", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { "fal-ai": { type: "http", url: "https://mcp.fal.ai/mcp", command: "uvx", headers: { Authorization: "Bearer k" } } },
    }));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix() });
    expect(row).toEqual({ agent: "claude", name: "fal-ai", providerId: "fal", transport: "http", status: "connected", scope: "user" });
  });

  it("a Codex stdio row can't start the same way; a disabled one stays disabled", async () => {
    const out = await detectRows({
      claudeConfigPath, agentDir, launcher: posix(),
      codexExec: async () => ({ ok: true as const, stdout: JSON.stringify([
        { name: "elevenlabs", enabled: true, transport: { type: "stdio", command: "uvx", env_vars: ["ELEVENLABS_API_KEY"] } },
        { name: "off-thing", enabled: false, transport: { type: "stdio", command: "uvx" } },
      ]) }),
    });
    expect(out).toEqual([
      { agent: "codex", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "cant-start", missingCommand: "uvx" },
      { agent: "codex", name: "off-thing", providerId: null, transport: "stdio", status: "disabled" },
    ]);
  });

  it("Windows: a bare command resolves through PATHEXT (platform pinned)", async () => {
    const found = new Set(["c:\\tools\\uvx.exe"]);
    const win = (files: Set<string>): LauncherDeps => ({
      platform: "win32",
      pathExt: ".COM;.EXE;.BAT;.CMD",
      loginShellDirs: () => null,
      processPathDirs: () => ["C:\\Tools"],
      isExecutable: (p) => files.has(p.toLowerCase()),
    });
    fs.writeFileSync(claudeConfigPath, elevenlabs("uvx"));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: win(found) });
    expect(row.status).toBe("connected");
    const [missing] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: win(new Set(["c:\\tools\\uvx"])) });
    expect(missing).toMatchObject({ status: "cant-start", missingCommand: "uvx" });
  });

  it("logs once per status change, with the entry name (as `entry`: `name` is the logger's own field) and command only", async () => {
    const info = vi.spyOn(serverLogger, "info");
    try {
      fs.writeFileSync(claudeConfigPath, elevenlabs("uvx"));
      await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix() });
      await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix() });
      // Unknown says nothing new about the launcher: no line, and the state it last logged stands.
      await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix({ loginShellDirs: () => null }) });
      await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix() });
      const launcherLines = () => info.mock.calls.filter(([fields]) => /^launcher_/.test(String((fields as { op?: string }).op)));
      expect(launcherLines()).toHaveLength(1);
      expect(launcherLines()[0][0]).toEqual({ tag: "providers", op: "launcher_missing", agent: "claude", entry: "elevenlabs", command: "uvx" });
      install("uvx");
      await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix() });
      await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: posix() });
      expect(launcherLines()).toHaveLength(2);
      expect(launcherLines()[1][0]).toEqual({ tag: "providers", op: "launcher_found", agent: "claude", entry: "elevenlabs", command: "uvx" });
    } finally {
      info.mockRestore();
    }
  });
});

// ElevenLabs moved to its hosted server (catalog `auth: "oauth"`, 2026-09-25). A hosted entry signs in and has no
// key; an older LOCAL entry (`uvx elevenlabs-mcp`) still runs on a key, so it keeps its key semantics — a local entry
// with no key needs one, and the Providers tab's Replace swaps it for the hosted server.
describe("detectProviders — ElevenLabs, hosted since 2026-09-25", () => {
  const found: LauncherDeps = { platform: "linux", loginShellDirs: () => [], processPathDirs: () => [], isExecutable: () => true };
  // `isExecutable` alone doesn't find a bare name on no folder, so give the lookup one folder where everything "is".
  const withUvx: LauncherDeps = { ...found, loginShellDirs: () => ["/fake/bin"] };

  it("a Claude HTTP entry at api.us is recognised by name, reads added, and its sign-in is unknown — never needs-key", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { elevenlabs: { type: "http", url: "https://api.us.elevenlabs.io/v1/mcp" } },
    }));
    expect(await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex })).toEqual([
      { agent: "claude", name: "elevenlabs", providerId: "elevenlabs", transport: "http", status: "connected", signIn: "unknown", scope: "user" },
    ]);
  });

  it("an entry under another name is recognised by its elevenlabs.io host", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { "my-voice": { type: "http", url: "https://api.elevenlabs.io/v1/mcp" } },
    }));
    const [row] = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex });
    expect(row).toMatchObject({ name: "my-voice", providerId: "elevenlabs", status: "connected", signIn: "unknown" });
  });

  it("Codex says whether the hosted entry is signed in", async () => {
    const codexExec = async () => ({ ok: true as const, stdout: JSON.stringify([
      { name: "elevenlabs", enabled: true, transport: { type: "streamable_http", url: "https://api.us.elevenlabs.io/v1/mcp" }, auth_status: "not_logged_in" },
    ]) });
    expect(await detectRows({ claudeConfigPath, agentDir, codexExec })).toEqual([
      { agent: "codex", name: "elevenlabs", providerId: "elevenlabs", transport: "http", status: "needs-sign-in" },
    ]);
  });

  it("a local entry with its key and its launcher reads connected, with no sign-in to ask about", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: { elevenlabs: { command: "uvx", args: ["elevenlabs-mcp"], env: { ELEVENLABS_API_KEY: "k" } } },
    }));
    expect(await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex, launcher: withUvx })).toEqual([
      { agent: "claude", name: "elevenlabs", providerId: "elevenlabs", transport: "stdio", status: "connected", scope: "user" },
    ]);
  });

  it("a local entry with no key still needs one, on Claude and on Codex", async () => {
    fs.writeFileSync(claudeConfigPath, JSON.stringify({ mcpServers: { elevenlabs: { command: "uvx", args: ["elevenlabs-mcp"] } } }));
    const codexExec = async () => ({ ok: true as const, stdout: JSON.stringify([
      { name: "elevenlabs", enabled: true, transport: { type: "stdio", command: "uvx", args: ["elevenlabs-mcp"] }, auth_status: "unsupported" },
    ]) });
    const rows = await detectRows({ claudeConfigPath, agentDir, codexExec, launcher: withUvx });
    expect(rows.map((r) => [r.agent, r.status, "signIn" in r])).toEqual([
      ["claude", "needs-key", false],
      ["codex", "needs-key", false],
    ]);
  });
});

// Claude Code's own answer (`claude mcp get`, lib/providers/claude-signin-probe.ts) goes over each Claude row whose
// sign-in the config can't show. The lookup is injected here; the probe itself is claude-signin-probe.test.ts's.
describe("detectProviders — Claude Code's own sign-in answer", () => {
  const EL_URL = "https://api.us.elevenlabs.io/v1/mcp";
  const writeConfig = () =>
    fs.writeFileSync(claudeConfigPath, JSON.stringify({
      mcpServers: {
        elevenlabs: { type: "http", url: EL_URL },
        higgsfield: { type: "http", url: "https://mcp.higgsfield.ai/mcp", headers: { Authorization: "Bearer own" } },
        "fal-ai": { type: "http", url: "https://mcp.fal.ai/mcp" },
        zernio: { command: "npx", args: ["zernio-mcp"] },
      },
    }));
  const base = { agent: "claude", name: "elevenlabs", providerId: "elevenlabs", transport: "http", scope: "user" } as const;
  const rowsWith = async (answer: "signed-in" | "needs-sign-in" | "unknown" | "pending", revalidateClaude?: boolean) => {
    const asked: Array<[string, string, boolean]> = [];
    const rows = await detectRows({
      claudeConfigPath,
      agentDir,
      codexExec: noCodex,
      revalidateClaude,
      claudeSignIn: (entry, opts) => {
        asked.push([entry.name, entry.url, opts.revalidate]);
        return answer;
      },
    });
    return { rows, asked };
  };

  it("asks only about an HTTP entry of a sign-in provider with no Authorization header, by its name and url", async () => {
    writeConfig();
    const { asked } = await rowsWith("unknown");
    expect(asked).toEqual([["elevenlabs", EL_URL, false]]);
  });

  it("signed in: the row is connected, with no sign-in left unknown", async () => {
    writeConfig();
    const { rows } = await rowsWith("signed-in");
    expect(rows.find((r) => r.name === "elevenlabs")).toEqual({ ...base, status: "connected" });
  });

  it("Claude Code says it needs authentication: needs-sign-in, the same state Codex's not_logged_in reads as", async () => {
    writeConfig();
    const { rows } = await rowsWith("needs-sign-in");
    expect(rows.find((r) => r.name === "elevenlabs")).toEqual({ ...base, status: "needs-sign-in" });
  });

  it("no answer yet: still unknown, marked as being checked", async () => {
    writeConfig();
    const { rows } = await rowsWith("pending");
    expect(rows.find((r) => r.name === "elevenlabs")).toEqual({ ...base, status: "connected", signIn: "unknown", signInCheck: "pending" });
  });

  it("an answer it couldn't read leaves the row as it was", async () => {
    writeConfig();
    const { rows } = await rowsWith("unknown");
    expect(rows.find((r) => r.name === "elevenlabs")).toEqual({ ...base, status: "connected", signIn: "unknown" });
  });

  it("a look or Retry (revalidateClaude) is handed to the lookup", async () => {
    writeConfig();
    expect((await rowsWith("unknown", true)).asked).toEqual([["elevenlabs", EL_URL, true]]);
    expect((await rowsWith("unknown")).asked).toEqual([["elevenlabs", EL_URL, false]]);
  });

  it("with the config injected and no lookup injected, nothing is probed: the row stays unknown", async () => {
    writeConfig();
    const rows = await detectRows({ claudeConfigPath, agentDir, codexExec: noCodex });
    expect(rows.find((r) => r.name === "elevenlabs")).toEqual({ ...base, status: "connected", signIn: "unknown" });
  });
});
