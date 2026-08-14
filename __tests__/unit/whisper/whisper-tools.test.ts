import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("@/mcp/jobs-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/jobs-client")>();
  return {
    ...actual,
    runJobViaServer: vi.fn(async () => ({
      status: "new",
      jobId: "job-1",
      clientKey: "ck-1",
      result: { model: "medium", alreadyInstalled: false },
    })),
    LibiServerUnavailableError: class extends Error {
      hint = "start libi";
    },
  };
});

import { runJobViaServer } from "@/mcp/jobs-client";
import {
  whisperListModels,
  whisperDownloadModel,
} from "@/mcp/tools/whisper-tools";
import { hfCacheDirName, whisperModelsDir } from "@/lib/whisper/models";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-wt-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("whisperListModels", () => {
  it("returns the catalog with installed/default flags", async () => {
    const res = await whisperListModels({});
    expect(res.success).toBe(true);
    expect(res.data!.default).toBe("small");
    const models = res.data!.models as Array<Record<string, unknown>>;
    expect(models).toHaveLength(5);
    expect(models.find((m) => m.id === "small")!.isDefault).toBe(true);
  });
});

describe("whisperDownloadModel", () => {
  it("short-circuits when already installed", async () => {
    const snap = path.join(
      whisperModelsDir(),
      hfCacheDirName("small"),
      "snapshots",
      "r1",
    );
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, "model.bin"), "x");
    const res = await whisperDownloadModel({ model: "small" });
    expect(res.success).toBe(true);
    expect(res.data!.status).toBe("already_installed");
    expect(runJobViaServer).not.toHaveBeenCalled();
  });

  it("runs the job when absent (status:'new')", async () => {
    const res = await whisperDownloadModel({ model: "medium" });
    expect(runJobViaServer).toHaveBeenCalledWith(
      "whisper_model_download",
      { model: "medium" },
      expect.objectContaining({ forceNew: false }),
    );
    expect(res.success).toBe(true);
    expect(res.data!.status).toBe("installed");
    expect(res.data!.jobId).toBe("job-1");
    expect(res.data!.clientKey).toBe("ck-1");
    expect(res.data!.attachedToRunning).toBeUndefined();
    expect(res.data!.matchedExisting).toBeUndefined();
  });
});

/** The shape whisperDownloadModel puts in `data` — narrowed from the loose
 *  `ToolResult.data` record for the shape-contract assertions below. */
type DownloadData = {
  status: string;
  model?: string;
  jobId?: string;
  clientKey?: string;
  forced?: boolean;
  attachedToRunning?: boolean;
  matchedExisting?: boolean;
  hint?: string;
  existingJob?: { jobId: string; status?: string };
};

// --- 4-shape RunJobResult contract (T17) -----------------------------------
describe("whisperDownloadModel RunJobResult shapes", () => {
  it("status:'new' with forced:true marks data.forced and forwards forceNew", async () => {
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      status: "new",
      jobId: "job-forced",
      clientKey: "ck-forced",
      forced: true,
      result: { model: "medium", alreadyInstalled: false },
    });

    const res = await whisperDownloadModel({
      model: "medium",
      forceNew: true,
    });
    expect(res.success).toBe(true);
    const d = res.data as DownloadData;
    expect(d.status).toBe("installed");
    expect(d.jobId).toBe("job-forced");
    expect(d.forced).toBe(true);
    expect(d.attachedToRunning).toBeUndefined();
    expect(d.matchedExisting).toBeUndefined();
    expect(runJobViaServer).toHaveBeenCalledWith(
      "whisper_model_download",
      { model: "medium" },
      expect.objectContaining({ forceNew: true }),
    );
  });

  it("status:'attached_running' surfaces attachedToRunning + existingJob", async () => {
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      status: "attached_running",
      jobId: "job-att",
      clientKey: "ck-att",
      existingJob: {
        jobId: "job-orig",
        pieceId: null,
        startedAt: "2026-05-21T10:00:00Z",
      },
      result: { model: "medium", alreadyInstalled: false },
    });

    const res = await whisperDownloadModel({ model: "medium" });
    expect(res.success).toBe(true);
    const d = res.data as DownloadData;
    expect(d.status).toBe("installed");
    expect(d.attachedToRunning).toBe(true);
    expect(d.matchedExisting).toBeUndefined();
    expect(d.existingJob).toEqual({
      jobId: "job-orig",
      pieceId: null,
      startedAt: "2026-05-21T10:00:00Z",
    });
    expect(d.jobId).toBe("job-att");
    expect(d.clientKey).toBe("ck-att");
  });

  it("status:'matching_completed' with a stale (cancelled/failed) job → status:'not_installed'", async () => {
    // No model files in the tmp dir → reaching this branch means the model
    // is genuinely absent — the tool must not claim "installed".
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      status: "matching_completed",
      existingJob: {
        jobId: "job-cached",
        pieceId: null,
        completedAt: "2026-05-20T12:00:00Z",
        status: "cancelled",
        result: undefined,
      },
    });

    const res = await whisperDownloadModel({ model: "medium" });
    expect(res.success).toBe(true);
    const d = res.data as DownloadData;
    expect(d.status).toBe("not_installed");
    expect(d.model).toBe("medium");
    expect(d.matchedExisting).toBe(true);
    expect(d.hint).toMatch(/forceNew/);
    expect(d.existingJob!.status).toBe("cancelled");
  });
});
