// __tests__/unit/jobs/export-runner-lane.test.ts
//
// Fix-round review N2: the `export` job's own wiring to the export lane. It
// takes the lane in the foreground (a background example render yields to
// it), waits behind another export, and a cancel while it waits gives up its
// place at once. The render is detected by its first act — creating the
// destination folder.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getExportLane } from "@/lib/export/export-lane";
import { exportRunner, type ExportParams } from "@/lib/jobs/runners/export";
import { CancelledError, type JobContext } from "@/lib/jobs/types";

let root = "";
let ticks: Array<[number, number, string | undefined]> = [];
function ctx(dest: string, shouldCancel: () => boolean = () => false): JobContext<ExportParams> {
  ticks = [];
  return {
    jobId: "export-1",
    params: { pieceId: "no-such-piece", source: "draft", filename: "x", destFolder: dest, settings: { format: "mp4", codec: "avc", bitrate: 1, width: 2, height: 2, fps: 1 } } as ExportParams,
    resumeState: null,
    reportProgress: (done, total, unit) => void ticks.push([done, total, unit]),
    checkpoint: async () => {},
    shouldCancel,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-export-lane-"));
  delete (globalThis as { __libiExportLane?: unknown }).__libiExportLane;
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("export job ↔ export lane", () => {
  it("takes the lane in the foreground: a background example render in progress is told to yield", async () => {
    const bg = await getExportLane().background();
    const dest = path.join(root, "a");
    const run = exportRunner.run(ctx(dest)).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(bg.signal.aborted).toBe(true);
    expect(fs.existsSync(dest)).toBe(false); // not before the render let go
    bg.release();
    await run;
    expect(fs.existsSync(dest)).toBe(true);
  });

  it("waits behind another export, and a cancel while waiting ends it without rendering and without a place in the queue", async () => {
    const other = await getExportLane().foreground();
    let cancelled = false;
    const dest = path.join(root, "b");
    const run = exportRunner.run(ctx(dest, () => cancelled));
    await new Promise((r) => setTimeout(r, 50));
    expect(fs.existsSync(dest)).toBe(false);
    cancelled = true;
    await expect(run).rejects.toBeInstanceOf(CancelledError);
    expect(fs.existsSync(dest)).toBe(false);
    other();
    const next = await Promise.race([getExportLane().foreground(), new Promise<null>((r) => setTimeout(() => r(null), 100))]);
    expect(next).not.toBeNull();
    next!();
  });

  it("says it is waiting for another export while it waits (final review F7) — and not when the lane is free", async () => {
    const other = await getExportLane().foreground();
    const dest = path.join(root, "c");
    const run = exportRunner.run(ctx(dest)).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 20));
    expect(ticks[0]).toEqual([0, 1, "waiting"]);
    other();
    await run;
    await exportRunner.run(ctx(path.join(root, "d"))).catch(() => undefined);
    expect(ticks.some(([, , u]) => u === "waiting")).toBe(false);
  });
});
