import { describe, it, expect, beforeEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb } from "../../helpers/test-db";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
// Mock the driver picker so we never spawn Chromium / Electron.
vi.mock("@/lib/export/drivers", () => ({
  pickDriver: vi.fn(),
}));
// Stub the libi-home port lookup so getCurrentPort() doesn't read a real port file.
vi.mock("@/lib/libi-home", async () => {
  const actual = await vi.importActual<typeof import("@/lib/libi-home")>(
    "@/lib/libi-home",
  );
  return {
    ...actual,
    getCurrentPort: vi.fn(() => 3000),
  };
});

import { getDb } from "@/lib/db/client";
import { pickDriver } from "@/lib/export/drivers";
import {
  __resetRunnerRegistryForTests,
  registerRunner,
} from "@/lib/jobs/runners/registry";
import { exportRenderRunner } from "@/lib/jobs/runners/export-render";
import {
  __resetRegistryForTests,
  getRenderJobTokenByJobId,
  resolveRenderJob,
} from "@/lib/export/render-jobs";
import { JobManager } from "@/lib/jobs/manager";
import { jobIdOf } from "../../helpers/enqueue";
import type { RenderPayload } from "@/lib/export/render-jobs";
import type { ExportSettings } from "@/lib/engine/types";

const SETTINGS: ExportSettings = {
  format: "mp4",
  codec: "avc",
  bitrate: 8_000_000,
  width: 1920,
  height: 1080,
  fps: 30,
};

const PAYLOAD: RenderPayload = {
  scenes: [],
  overlays: [],
  audioClips: [],
  width: 1920,
  height: 1080,
  fps: 30,
  files: [],
};

describe("exportRenderRunner", () => {
  let tmp: string;
  beforeEach(() => {
    __resetRunnerRegistryForTests();
    __resetRegistryForTests();
    registerRunner(exportRenderRunner);
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-export-runner-"));
    process.env.LIBI_HOME = tmp;
    fs.mkdirSync(path.join(tmp, "jobs"), { recursive: true });
    vi.mocked(getDb).mockReturnValue(createTestDb() as never);
    delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  });

  it("happy path: invokes driver.runJob, awaits registry resolution, returns the output", async () => {
    // Driver simulates the render page by resolving the registry entry once
    // it's been given a chance to "render".
    const driver = {
      name: "playwright" as const,
      runJob: vi.fn(async ({ jobId }: { jobId: string; port: number }) => {
        const tok = getRenderJobTokenByJobId(jobId);
        if (!tok) throw new Error("no token");
        resolveRenderJob(jobId, tok.token, {
          tempFilePath: "/tmp/out.mp4",
          durationSeconds: 12.5,
        });
      }),
      shutdown: vi.fn(async () => {}),
    };
    vi.mocked(pickDriver).mockReturnValue(driver);

    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("export_render", {
      pieceId: "p",
      payload: PAYLOAD,
      settings: SETTINGS,
    }));
    const result = await mgr.runToCompletion<{
      tempFilePath: string;
      durationSeconds: number;
    }>(jobId);

    expect(result.tempFilePath).toBe("/tmp/out.mp4");
    expect(result.durationSeconds).toBe(12.5);
    expect(driver.runJob).toHaveBeenCalledTimes(1);
    expect(driver.runJob).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3000, jobId: expect.any(String) }),
    );
  });

  it("propagates driver errors as job failure", async () => {
    const driver = {
      name: "playwright" as const,
      runJob: vi.fn(async () => {
        throw new Error("driver boom");
      }),
      shutdown: vi.fn(async () => {}),
    };
    vi.mocked(pickDriver).mockReturnValue(driver);

    const mgr = new JobManager();
    const jobId = jobIdOf(await mgr.enqueue("export_render", {
      pieceId: "p2",
      payload: PAYLOAD,
      settings: SETTINGS,
    }));
    await expect(mgr.runToCompletion(jobId)).rejects.toThrow(/driver boom/);
  });
});
