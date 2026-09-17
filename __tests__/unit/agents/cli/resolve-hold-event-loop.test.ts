import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * `libi connect` printed its "Connecting …" line and exited 0 having done
 * nothing (live QA, 2026-09-12). The login-shell PATH probe unrefs its shell
 * and the shell's stdout so it never holds the SERVER's event loop open; in the
 * one-shot CLI nothing else held it either, so Node went idle and exited while
 * `resolveAgentCli` was still waiting for the shell. The promise never settled,
 * so nothing could report it.
 *
 * Only a process that nothing else holds open shows this, so each case runs the
 * fixture as its own node process (tsx) — with the real resolver and the real
 * probe, and a fake shell whose handles are unref'd the way the real ones are.
 */
const ROOT = path.resolve(__dirname, "../../../..");
const TSX = path.join(ROOT, "node_modules", ".bin", "tsx");
const FIXTURE = path.join(ROOT, "__tests__", "fixtures", "cli", "resolve-hold-event-loop.ts");

interface Report {
  settled: boolean;
  dirs: string[] | null;
  found: boolean | null;
  settleToIdleMs: number | null;
}

function runFixture(mode: string): Promise<{ code: number | null; report: Report }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "libi-resolve-hold-"));
  return new Promise((resolve, reject) => {
    // A minimal env: no test-route or CLI-dir hooks from the parent can leak in.
    const child = spawn(TSX, ["--tsconfig", path.join(ROOT, "tsconfig.json"), FIXTURE, mode], {
      cwd: ROOT,
      env: { NODE_ENV: "test", PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, LIBI_HOME: path.join(home, "libi") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c: Buffer) => (out += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (err += c.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => {
      fs.rmSync(home, { recursive: true, force: true });
      const line = out.trim().split("\n").filter((l) => l.startsWith("{")).pop();
      if (!line) return reject(new Error(`fixture printed no report (exit ${code}): ${err.slice(0, 500)}`));
      resolve({ code, report: JSON.parse(line) as Report });
    });
  });
}

describe("resolveAgentCli in a process nothing else holds open", () => {
  it("without holdEventLoop the unref'd probe lets the process go idle before it answers — the defect this option exists for", async () => {
    const { code, report } = await runFixture("nohold-answer");
    expect(report.settled).toBe(false);
    expect(report.dirs).toBeNull();
    expect(code).toBe(0); // exactly the silent exit 0 the QA run saw
  }, 30_000);

  it("with holdEventLoop it waits for the probe's answer, settles, and releases the process straight after", async () => {
    const { code, report } = await runFixture("hold-answer");
    expect(report.settled).toBe(true);
    expect(report.dirs).toEqual(["/fake/bin", "/usr/bin"]);
    expect(report.found).toBe(false);
    // The hold is dropped the moment the resolution settles: it never keeps a finished CLI alive.
    expect(report.settleToIdleMs).toBeLessThan(1_000);
    expect(code).toBe(0);
  }, 30_000);

  it("with holdEventLoop a shell that never answers is still bounded: the probe times out, kills it, and the resolution settles with nothing found", async () => {
    const { code, report } = await runFixture("hold-hang");
    expect(report.settled).toBe(true);
    expect(report.dirs).toEqual([]);
    expect(report.found).toBe(false);
    expect(report.settleToIdleMs).toBeLessThan(1_000);
    expect(code).toBe(0);
  }, 30_000);
});
