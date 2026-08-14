import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, seedPiece } from "../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
vi.mock("@/lib/libi-home", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/libi-home")>("@/lib/libi-home");
  return {
    ...actual,
    getCurrentPort: () => 4242,
  };
});

import { getDb } from "@/lib/db/client";
import { ChromiumRenderBackend } from "@/lib/export/backends/chromium-render";
import { __resetRegistryForTests, resolveRenderJob } from "@/lib/export/render-jobs";
import { __resetDriverForTests } from "@/lib/export/drivers";
import type { RenderDriver } from "@/lib/export/drivers";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
} from "@/lib/jobs/runners/registry";
import { exportRenderRunner } from "@/lib/jobs/runners/export-render";

// Per-test driver override: tests assign `currentDriver` before calling
// `backend.run(...)`, and the mocked `pickDriver` returns whatever is
// currently set. Default is the happy-path driver that resolves the job.
let currentDriver: RenderDriver = makeHappyDriver();

function makeHappyDriver(): RenderDriver {
  return {
    name: "electron",
    runJob: async ({ jobId }: { jobId: string }) => {
      const dir = await mkdtemp(join(tmpdir(), "test-render-"));
      const filePath = join(dir, "out.mp4");
      await writeFile(filePath, new Uint8Array([1, 2, 3, 4]));
      // Simulate the render page posting back by resolving the registry
      // entry directly. This requires the token — look it up via an
      // internal test-only helper.
      const { getRenderJobTokenByJobId } = await import("@/lib/export/render-jobs");
      const entry = getRenderJobTokenByJobId(jobId);
      if (!entry) throw new Error("no entry");
      resolveRenderJob(jobId, entry.token, { tempFilePath: filePath, durationSeconds: 1.25 });
    },
    shutdown: async () => {},
  };
}

vi.mock("@/lib/export/drivers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/export/drivers")>("@/lib/export/drivers");
  return {
    ...actual,
    pickDriver: () => currentDriver,
  };
});

describe("ChromiumRenderBackend", () => {
  let tmp: string;

  beforeEach(() => {
    __resetRegistryForTests();
    __resetDriverForTests();
    __resetRunnerRegistryForTests();
    registerRunner(exportRenderRunner);
    currentDriver = makeHappyDriver();

    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-export-test-"));
    process.env.LIBI_HOME = tmp;
    fs.mkdirSync(path.join(tmp, "jobs"), { recursive: true });
    const db = createTestDb();
    vi.mocked(getDb).mockReturnValue(db as never);
    seedPiece(db, { id: "p1" });
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  });

  afterEach(() => {
    delete process.env.LIBI_HOME;
    if (tmp && fs.existsSync(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  });

  it("submits a job, awaits driver, reads the temp file back, returns an ExportResult", async () => {
    const be = new ChromiumRenderBackend();
    const result = await be.run({
      pieceId: "p1",
      composition: { id: "c1" } as never,
      payload: {
        scenes: [],
        overlays: [],
        audioClips: [],
        width: 1920,
        height: 1080,
        fps: 30,
        files: [],
      },
      settings: { format: "mp4", codec: "avc", bitrate: 1_000_000, width: 1920, height: 1080, fps: 30 } as never,
      onProgress: () => {},
      signal: new AbortController().signal,
    });
    expect(result.duration).toBe(1.25);
    expect(result.format).toBe("mp4");
    expect(result.blob).toBeInstanceOf(Blob);
    expect(result.blob.size).toBe(4);
  });

  it("rejects the job when the driver throws", async () => {
    // The driver's `name` union is narrow (electron | playwright), but
    // here we want to assert the error message format. Use "electron" —
    // what matters for the test is that `runJob` rejects.
    currentDriver = {
      name: "electron",
      runJob: async () => {
        throw new Error("loadURL failed");
      },
      shutdown: async () => {},
    };
    const be = new ChromiumRenderBackend();
    await expect(
      be.run({
        pieceId: "p1",
        composition: { id: "c1" } as never,
        payload: {
          scenes: [],
          overlays: [],
          audioClips: [],
          width: 1920,
          height: 1080,
          fps: 30,
          files: [],
        },
        settings: { format: "mp4", codec: "avc", bitrate: 1_000_000, width: 1920, height: 1080, fps: 30 } as never,
        onProgress: () => {},
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Driver electron failed: loadURL failed/);
  });
});
