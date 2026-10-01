/**
 * DependencyManager's log lines carry `tag: "deps"` and a fixed `op`, and name
 * the REAL bin folder.
 *
 * 0.1.16 full verification F12: "Installing yt-dlp via uv tool install" and
 * "Custom installer succeeded" had no tag/op (AGENTS.md: every line gets
 * both), and the wrapper line said "~/.libi/bin" whatever LIBI_HOME was.
 *
 * Driven for real on POSIX with a fake `uv` (as yt-dlp-launcher-heal.test.ts
 * does); only DB transitions and analytics are stubbed, and the logger is
 * captured.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

vi.mock("@/mcp/registry/dep-transition", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/registry/dep-transition")>()),
  writeDepTransition: vi.fn(),
}));
vi.mock("@/lib/analytics/server", () => ({ trackServerEvent: vi.fn() }));
vi.mock("@/lib/db/client", async () => {
  const { createTestDb } = await import("../../../helpers/test-db");
  const db = createTestDb();
  return { getDb: () => db };
});

type Call = { level: string; fields: Record<string, unknown>; msg: string };
const calls: Call[] = [];
vi.mock("@/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/logger")>();
  const record =
    (level: string) =>
    (fields: Record<string, unknown>, msg?: string) =>
      calls.push({ level, fields, msg: msg ?? "" });
  const spy: Record<string, unknown> = {
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    debug: record("debug"),
    trace: record("trace"),
  };
  // Modules the installer pulls in derive tagged children at load.
  spy.child = () => spy;
  return { ...actual, serverLogger: spy };
});

const realPlatform = process.platform;
const savedHome = process.env.LIBI_HOME;
let tmp: string;
let home: string;

function writeFakeUv(binDir: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(
    path.join(binDir, "uv"),
    `#!/bin/bash\n` +
      `if [ "$1" = tool ] && [ "$2" = install ]; then\n` +
      `  mkdir -p "$UV_TOOL_DIR/yt-dlp/bin"\n` +
      `  printf '#!/bin/sh\\necho fake-yt-dlp\\n' > "$UV_TOOL_DIR/yt-dlp/bin/yt-dlp"\n` +
      `  chmod +x "$UV_TOOL_DIR/yt-dlp/bin/yt-dlp"\n` +
      `  exit 0\n` +
      `fi\n` +
      `if [ "$1" = tool ] && [ "$2" = dir ]; then echo "$UV_TOOL_DIR"; exit 0; fi\n` +
      `exit 1\n`,
    { mode: 0o755 },
  );
}

beforeEach(() => {
  // A home that is NOT ~/.libi, so a hardcoded "~/.libi/bin" can't pass.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-deps-log-"));
  home = path.join(tmp, "custom-home");
  writeFakeUv(path.join(home, "bin"));
  process.env.LIBI_HOME = home;
  calls.length = 0;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = savedHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.skipIf(realPlatform === "win32")("DependencyManager install-path log lines", () => {
  it("the yt-dlp install logs install_start → wrapper_written → custom_installer_ok under tag deps", async () => {
    const { DependencyManager } = await import("@/mcp/registry/dependency-manager");
    const { BUNDLED_MCP_SERVERS } = await import("@/mcp/registry/bundled");
    const dep = BUNDLED_MCP_SERVERS.find((d) => d.id === "youtube-download")!.dependencies.find(
      (d) => d.binary === "yt-dlp",
    )!;
    const dm = new DependencyManager() as unknown as {
      runCustomInstaller: (d: typeof dep) => Promise<void>;
    };
    await dm.runCustomInstaller(dep);

    const ops = calls.filter((c) => c.fields.tag === "deps").map((c) => c.fields.op);
    expect(ops).toEqual(["install_start", "wrapper_written", "custom_installer_ok"]);

    const wrapper = calls.find((c) => c.fields.op === "wrapper_written")!;
    const binDir = path.join(home, "bin");
    expect(wrapper.msg).toContain(binDir);
    expect(wrapper.msg).not.toContain("~/.libi");
    expect(calls.find((c) => c.fields.op === "custom_installer_ok")!.fields).toMatchObject({
      binary: "yt-dlp",
      via: "uv",
    });
  });
});

describe("every DependencyManager log line", () => {
  // Source-level, so a line added later can't skip the convention either.
  const src = fs.readFileSync(path.resolve("mcp/registry/dependency-manager.ts"), "utf-8");
  const logCalls: Array<{ line: number; text: string }> = [];
  for (const m of src.matchAll(/\blogger\.(info|warn|error|debug|trace)\(/g)) {
    let depth = 0;
    let end = m.index! + m[0].length - 1;
    for (; end < src.length; end++) {
      if (src[end] === "(") depth++;
      else if (src[end] === ")" && --depth === 0) break;
    }
    logCalls.push({ line: src.slice(0, m.index).split("\n").length, text: src.slice(m.index, end + 1) });
  }

  it("was found", () => {
    expect(logCalls.length).toBeGreaterThan(20);
  });

  it("carries a tag and an op", () => {
    const missing = logCalls
      .filter((c) => !/\btag:/.test(c.text) || !/\bop:/.test(c.text))
      .map((c) => `dependency-manager.ts:${c.line}`);
    expect(missing).toEqual([]);
  });

  it("never names ~/.libi in its message", () => {
    const hardcoded = logCalls
      .filter((c) => c.text.includes("~/.libi"))
      .map((c) => `dependency-manager.ts:${c.line}`);
    expect(hardcoded).toEqual([]);
  });
});
