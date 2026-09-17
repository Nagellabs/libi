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
import { detectProviders, __clearProviderMemo, type DetectDeps } from "@/lib/providers/detect";

/** The rows alone; the cases that are about whether Codex's rows are a fresh answer read `detectProviders` whole. */
const detectRows = async (deps: DetectDeps) => (await detectProviders(deps)).connected;

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
    expect(await detectProviders({
      claudeConfigPath, agentDir,
      codexExec: async () => ({ ok: true as const, stdout: "not json" }),
    })).toEqual({ connected: [], codex: "unread" });
    expect(await detectProviders({ claudeConfigPath, agentDir, resolveCodex: async () => NATIVE, codexList: async () => null }))
      .toEqual({ connected: [], codex: "unread" });
    // A real empty listing, and no codex at all, are answers.
    expect(await detectProviders({ claudeConfigPath, agentDir, codexExec: async () => ({ ok: true as const, stdout: "[]" }) }))
      .toEqual({ connected: [] });
    expect(await detectProviders({ claudeConfigPath, agentDir, resolveCodex: async () => null, codexList: async () => [] }))
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
