/**
 * An in-app update must produce a runtime the MCP child can actually use.
 *
 * `installRuntime` ran `--ignore-scripts` and then ONLY the Electron prebuild
 * fetch. better-sqlite3's published tarball ships sources only (no `build/`,
 * no `prebuilds/`, and it uses `bindings` rather than `node-gyp-build`, so
 * there is no in-tarball fallback) — so every fetched runtime had exactly one
 * binding, for the wrong interpreter, and every DB-backed `libi.*` tool died
 * at first agent use behind a completely healthy-looking app.
 *
 * These tests pin the three properties that make the fix load-bearing:
 * sidecars are parked, the Electron binding is still the default, and a
 * zero-sidecar outcome fails the install rather than shipping.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const calls: string[][] = [];
/** Majors the fake prebuild-install refuses to produce a binding for. */
let unavailableMajors: number[] = [];

vi.mock("node:child_process", () => ({
  execFile: (
    _cmd: string,
    args: string[],
    _opts: unknown,
    cb: (e: Error | null, r: { stdout: string; stderr: string }) => void,
  ) => {
    calls.push(args);
    const target = /--target=(\d+)/.exec(args.join(" "))?.[1];
    const major = target ? Number(target) : null;
    if (major != null && unavailableMajors.includes(major)) {
      cb(new Error("No prebuilt binaries found"), { stdout: "", stderr: "" });
      return;
    }
    // A real `prebuild-install` run lands the binding at build/Release.
    const cwd = (_opts as { cwd: string }).cwd;
    const rel = path.join(cwd, "build", "Release");
    fs.mkdirSync(rel, { recursive: true });
    fs.writeFileSync(path.join(rel, "better_sqlite3.node"), `binding-${target}`);
    cb(null, { stdout: "", stderr: "" });
  },
}));

vi.mock("@/lib/runtime/node-runtime", () => ({ resolveNodeCommand: () => "node" }));
vi.mock("@/mcp/registry/spawn-env", () => ({ buildSpawnEnv: () => ({}) }));
vi.mock("@/lib/logger", () => ({
  serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

let tmp: string;

/** A prefix shaped like the tree `npm install --ignore-scripts` leaves. */
function makePrefix(): string {
  const moduleDir = path.join(tmp, "node_modules", "better-sqlite3");
  fs.mkdirSync(moduleDir, { recursive: true });
  const bin = path.join(tmp, "node_modules", "prebuild-install", "bin.js");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, "// fake");
  return tmp;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-rt-sidecar-"));
  calls.length = 0;
  unavailableMajors = [];
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("fetchNodeAbiSidecars", () => {
  it("parks one binding per supported Node major", async () => {
    const { fetchNodeAbiSidecars } = await import("@/lib/runtime/runtime-install");
    const { NODE_ABI_SIDECAR_MAJORS, sidecarMajorsInPrefix } = await import(
      "@/lib/runtime/node-abi-sidecars"
    );
    const prefix = makePrefix();

    const fetched = await fetchNodeAbiSidecars({ prefix });

    expect(fetched).toEqual([...NODE_ABI_SIDECAR_MAJORS]);
    expect(sidecarMajorsInPrefix(prefix)).toEqual([...NODE_ABI_SIDECAR_MAJORS]);
  });

  it("asks for the NODE runtime, not Electron's", async () => {
    const { fetchNodeAbiSidecars } = await import("@/lib/runtime/runtime-install");
    await fetchNodeAbiSidecars({ prefix: makePrefix() });
    for (const args of calls) {
      expect(args).toContain("--runtime=node");
    }
  });

  // Ordering is the whole safety argument: the Electron fetch runs next and
  // rewrites build/Release. Leaving the LAST NODE binding sitting under the
  // Electron name would put a wrong-ABI binary exactly where the in-process
  // Next server loads it with no lookup at all.
  it("leaves no default binding behind for the Electron fetch to inherit", async () => {
    const { fetchNodeAbiSidecars } = await import("@/lib/runtime/runtime-install");
    const prefix = makePrefix();
    await fetchNodeAbiSidecars({ prefix });
    expect(
      fs.existsSync(
        path.join(prefix, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"),
      ),
    ).toBe(false);
  });

  it("skips a major better-sqlite3 publishes no prebuild for", async () => {
    unavailableMajors = [20];
    const { fetchNodeAbiSidecars } = await import("@/lib/runtime/runtime-install");
    const fetched = await fetchNodeAbiSidecars({ prefix: makePrefix() });
    expect(fetched).not.toContain(20);
    expect(fetched.length).toBeGreaterThan(0);
  });

  it("FAILS the install when no major produced a binding", async () => {
    const { NODE_ABI_SIDECAR_MAJORS } = await import("@/lib/runtime/node-abi-sidecars");
    unavailableMajors = [...NODE_ABI_SIDECAR_MAJORS];
    const { fetchNodeAbiSidecars } = await import("@/lib/runtime/runtime-install");
    await expect(fetchNodeAbiSidecars({ prefix: makePrefix() })).rejects.toThrow(
      /separate Node process/,
    );
  });

  it("names github.com so a blocked-proxy user can self-diagnose", async () => {
    const { NODE_ABI_SIDECAR_MAJORS } = await import("@/lib/runtime/node-abi-sidecars");
    unavailableMajors = [...NODE_ABI_SIDECAR_MAJORS];
    const { fetchNodeAbiSidecars, PREBUILD_HOST } = await import(
      "@/lib/runtime/runtime-install"
    );
    await expect(fetchNodeAbiSidecars({ prefix: makePrefix() })).rejects.toMatchObject({
      kind: "prebuild-unreachable",
      host: PREBUILD_HOST,
    });
  });

  it("reports honestly when better-sqlite3 is not in the tree at all", async () => {
    const { fetchNodeAbiSidecars } = await import("@/lib/runtime/runtime-install");
    await expect(fetchNodeAbiSidecars({ prefix: tmp })).rejects.toThrow(
      /better-sqlite3 is not present/,
    );
  });
});
