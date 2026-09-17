import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `mcp/index.ts` — the stdio MCP entry point — is compiled into
 * `dist-cli/mcp/index.js`, and `scripts/local-registry` refuses to publish a
 * tarball without it. Its spawn spec, `buildLibiEntry()`, lost its last
 * production caller when `getMcpServersForSettings()` was deleted, so a whole
 * shipped, release-gated entry point had nothing exercising it: it could have
 * stopped starting at all and every gate would still have been green.
 *
 * The decision was to KEEP the surface (see `buildLibiEntry`'s header for why)
 * and supply the missing proof. This is that proof, and it is end to end on
 * purpose — the spec that would really be handed to an MCP client, spawned,
 * and driven through a real `initialize` + `tools/list` handshake. A unit test
 * over the resolver only proves a path string.
 *
 * Modelled on `__tests__/integration/tracking/tracking-mcp-spawn.test.ts`, with
 * one deliberate difference: `LIBI_HOME` is pinned to a temp dir. The child
 * calls `ensureLibiDirs()`, and this must never touch the developer's real
 * `~/.libi`.
 */

let tmpHome: string;
let prevHome: string | undefined;

beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-stdio-entry-"));
  prevHome = process.env.LIBI_HOME;
  // Read by `buildSpawnEnv()` inside `buildLibiEntry()`, which pins it into the
  // child's env — the same mechanism that keeps a worktree session's pieces out
  // of the canonical home.
  process.env.LIBI_HOME = tmpHome;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = prevHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

interface RpcResult {
  id: number;
  result?: Record<string, unknown>;
  error?: unknown;
}

/** Drive the spawned server through one JSON-RPC exchange per request. */
async function handshake(
  command: string,
  args: string[],
  env: Record<string, string>,
  requests: Array<Record<string, unknown>>,
): Promise<{ responses: RpcResult[]; stderr: string }> {
  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, ...env },
  });

  const responses: RpcResult[] = [];
  let stderr = "";
  let buf = "";
  // Notifications carry no `id` and are never answered, so they do not count
  // towards what we wait for.
  const expected = requests.filter((r) => r.id !== undefined).length;

  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${responses.length} response(s); stderr=${stderr.slice(-1200)}`));
    }, 90_000);
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (d: string) => {
      stderr += d;
    });
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as RpcResult;
          if (typeof msg.id === "number") responses.push(msg);
        } catch {
          // Not a JSON-RPC frame — the transport is line-delimited, so this is
          // stray output and belongs in the failure message, not the results.
          stderr += `\n[stdout non-json] ${line}`;
        }
      }
      if (responses.length >= expected) {
        clearTimeout(timer);
        child.kill("SIGKILL");
        resolve();
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      if (responses.length < expected) {
        clearTimeout(timer);
        reject(new Error(`child exited after ${responses.length} response(s); stderr=${stderr.slice(-1200)}`));
      }
    });
  });

  for (const req of requests) child.stdin.write(JSON.stringify(req) + "\n");
  await done;
  return { responses, stderr };
}

describe("the stdio MCP entry point actually serves tools", () => {
  it("spawns buildLibiEntry()'s spec and answers initialize + tools/list", async () => {
    // Imported here, not at module scope: it reads `process.env.LIBI_HOME` and
    // `process.cwd()` when called, and `beforeAll` has to have run first.
    const { buildLibiEntry } = await import("@/lib/mcp-config");
    const entry = buildLibiEntry() as {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

    expect(entry.command).toBeTruthy();
    // The env pin is the reason a codex-spawned child writes to the right home
    // at all (codex-acp sanitizes the child env).
    expect(entry.env?.LIBI_HOME).toBe(tmpHome);

    const { responses, stderr } = await handshake(
      entry.command,
      entry.args ?? [],
      entry.env ?? {},
      [
        {
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "f86-spawn-test", version: "0" },
          },
        },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      ],
    );

    const init = responses.find((r) => r.id === 1);
    expect(init?.error, `initialize failed; stderr=${stderr.slice(-1200)}`).toBeUndefined();
    expect(init?.result).toBeDefined();
    expect((init!.result as { serverInfo?: { name?: string } }).serverInfo?.name).toBeTruthy();

    const list = responses.find((r) => r.id === 2);
    expect(list?.error, `tools/list failed; stderr=${stderr.slice(-1200)}`).toBeUndefined();
    const tools = (list!.result as { tools?: Array<{ name: string }> }).tools ?? [];

    // The failure this guards is silent and total: a zod-v4 import anywhere in
    // a tool schema makes the SDK's JSON-schema conversion fail without an
    // error and EVERY tool disappears from `tools/list`. An entry point nobody
    // exercises is exactly where that goes unnoticed.
    expect(tools.length).toBeGreaterThan(50);
    const names = tools.map((t) => t.name);
    expect(names).toContain("libi.list_providers");
    expect(names).toContain("libi.read_manual");
  }, 120_000);
});
