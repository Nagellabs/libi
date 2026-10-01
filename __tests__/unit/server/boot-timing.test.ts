/**
 * EL-4 (Windows verification F3): the installed Windows first boot took ~4 min
 * between Category A and the published port, where the same runtime copied
 * elsewhere took 45 s. One `lifecycle` line now says where that time goes —
 * the externals farm build, Category A → port bound, Category A → Next ready —
 * so the RDP check (release plan O17) reads it instead of guessing.
 *
 * `op` says what happened to the farm (review m4): `farm_built` when there was
 * none before this boot (a Windows first boot: the installer ships none),
 * `farm_repaired` when there was one and links were still made — the old
 * delete-and-relink of dereferenced copies, which `farmCopiesReplaced` counts —
 * and `boot_timing` when it was only verified. `farmExisted` says which, so the
 * VM check can tell "created from nothing" from "deleted and relinked".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const h = vi.hoisted(() => ({
  info: vi.fn(),
  externals: { created: [] as string[], verified: [] as string[] },
}));
vi.mock("next", () => ({
  default: () => ({ getRequestHandler: () => () => {}, prepare: async () => {} }),
}));
vi.mock("next-logger", () => ({}));
vi.mock("@/lib/install/next-externals", () => ({
  ensureNextExternalSymlinks: vi.fn(() => h.externals),
}));

import { startNextServer } from "@/lib/server/next-server";
import { logBootTiming, markInstallPhaseStart, msSinceInstallPhaseStart, resetBootTimingForTests } from "@/lib/server/lifecycle/boot-timing";
import { runInstallPhase } from "@/lib/server/lifecycle";
import { serverLogger } from "@/lib/logger";

const saved = { PORT: process.env.PORT, LIBI_PORT: process.env.LIBI_PORT };
beforeEach(() => {
  h.info.mockReset();
  vi.spyOn(serverLogger, "info").mockImplementation(h.info as never);
  resetBootTimingForTests();
});
afterEach(() => {
  vi.restoreAllMocks();
  process.env.PORT = saved.PORT;
  process.env.LIBI_PORT = saved.LIBI_PORT;
  if (saved.PORT === undefined) delete process.env.PORT;
  if (saved.LIBI_PORT === undefined) delete process.env.LIBI_PORT;
});

const TIMING_OPS = ["farm_built", "farm_repaired", "boot_timing"];
const timingCall = () => h.info.mock.calls.find(([o]) => TIMING_OPS.includes((o as { op?: string }).op ?? ""));

describe("boot timing", () => {
  it("runInstallPhase marks when Category A started", async () => {
    expect(msSinceInstallPhaseStart()).toBeNull();
    await runInstallPhase({ adapter: { onEvent: () => {} }, deps: { installBinaryDeps: async () => {}, ensureNodeRuntime: async () => {} } as never });
    expect(msSinceInstallPhaseStart()).toBeGreaterThanOrEqual(0);
  });

  it("a boot that built the farm from nothing logs farm_built (tag lifecycle) with the farm and Category A → port / ready durations", async () => {
    h.externals = { created: ["a", "b", "c"], verified: ["d"] };
    markInstallPhaseStart(Date.now() - 4_000);
    const lines: string[] = [];
    const { server } = await startNextServer({ dir: "/nonexistent-runtime", log: (m) => lines.push(m) });
    server.close();
    const call = timingCall();
    expect(call, "one timing line").toBeTruthy();
    const [fields] = call!;
    expect(fields).toMatchObject({ tag: "lifecycle", op: "farm_built", surface: "electron", farmCreated: 3, farmVerified: 1, farmExisted: false, farmCopiesReplaced: 0 });
    expect(fields.farmMs).toBeGreaterThanOrEqual(0);
    expect(fields.categoryAToPortMs).toBeGreaterThanOrEqual(4_000);
    expect(fields.categoryAToReadyMs).toBeGreaterThanOrEqual(fields.categoryAToPortMs);
    // The shell's own sync log gets the farm's duration on its existing line.
    expect(lines.some((l) => /externals created=3 verified=1 in \d+ms \(farm dir existed before boot: no\)/.test(l))).toBe(true);
  });

  it("a boot that made links over a farm that was already there (dereferenced copies) logs farm_repaired and counts the copies", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-boot-timing-"));
    try {
      const farm = path.join(dir, ".next", "node_modules");
      fs.mkdirSync(path.join(farm, "pino-0a1b2c"), { recursive: true });
      fs.mkdirSync(path.join(farm, "@napi-rs", "canvas-def456"), { recursive: true });
      fs.mkdirSync(path.join(dir, "target"), { recursive: true });
      fs.symlinkSync(path.join(dir, "target"), path.join(farm, "esbuild-123"), "dir");
      h.externals = { created: ["a", "b"], verified: ["c"] };
      const lines: string[] = [];
      const { server } = await startNextServer({ dir, log: (m) => lines.push(m) });
      server.close();
      expect(timingCall()![0]).toMatchObject({ op: "farm_repaired", farmExisted: true, farmCopiesReplaced: 2, farmCreated: 2 });
      expect(lines.some((l) => /\(farm dir existed before boot: yes, 2 real-directory copies\)/.test(l))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a boot that only verified the farm logs boot_timing", async () => {
    h.externals = { created: [], verified: ["a"] };
    markInstallPhaseStart();
    const { server } = await startNextServer({ dir: "/nonexistent-runtime" });
    server.close();
    expect(timingCall()![0]).toMatchObject({ tag: "lifecycle", op: "boot_timing", farmCreated: 0 });
  });

  it("no Category A mark (a caller that skipped it): the Category A durations are null, the line still lands", () => {
    logBootTiming({ surface: "cli", farmMs: 12, farmCreated: 0, farmVerified: 9, farmExisted: true, farmCopiesReplaced: 0, portAt: Date.now(), readyAt: Date.now() });
    expect(timingCall()![0]).toMatchObject({ op: "boot_timing", surface: "cli", farmMs: 12, categoryAToPortMs: null, categoryAToReadyMs: null });
  });
});
