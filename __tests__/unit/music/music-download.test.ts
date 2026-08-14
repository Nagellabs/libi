import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

vi.mock("@/mcp/jobs-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/mcp/jobs-client")>();
  return {
    ...actual,
    runJobViaServer: vi.fn(),
    LibiServerUnavailableError: class extends Error {
      hint = "start libi";
    },
  };
});

import { runJobViaServer, type RunJobResult } from "@/mcp/jobs-client";
import { musicDownloadModel } from "@/mcp/tools/music-tools";

/** The `data` payload musicDownloadModel returns (see mcp/tools/music-tools.ts). */
type MusicDownloadData = {
  status: string;
  jobId?: string;
  clientKey?: string;
  forced?: boolean;
  attachedToRunning?: boolean;
  matchedExisting?: boolean;
  hint?: string;
  existingJob?: {
    jobId: string;
    pieceId: string | null;
    startedAt?: string;
    completedAt?: string;
    status?: string;
  };
};

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-music-dl-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("musicDownloadModel short-circuit", () => {
  it("returns already_installed when model is on disk and force:false", async () => {
    const models = await import("@/lib/music/models");
    vi.spyOn(models, "isAceStepModelInstalled").mockReturnValue(true);

    const r = await musicDownloadModel({});
    expect(r.success).toBe(true);
    expect((r.data as MusicDownloadData).status).toBe("already_installed");
    expect(runJobViaServer).not.toHaveBeenCalled();
  });
});

describe("musicDownloadModel RunJobResult shapes", () => {
  beforeEach(async () => {
    const models = await import("@/lib/music/models");
    vi.spyOn(models, "isAceStepModelInstalled").mockReturnValue(false);
  });

  it("status:'new' surfaces jobId + clientKey, no dedup markers", async () => {
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      status: "new",
      jobId: "job-new",
      clientKey: "ck-new",
      result: { alreadyInstalled: false },
    } satisfies RunJobResult<{ alreadyInstalled: boolean }>);

    const r = await musicDownloadModel({});
    expect(r.success).toBe(true);
    const d = r.data as MusicDownloadData;
    expect(d.status).toBe("installed");
    expect(d.jobId).toBe("job-new");
    expect(d.clientKey).toBe("ck-new");
    expect(d.attachedToRunning).toBeUndefined();
    expect(d.matchedExisting).toBeUndefined();
    expect(runJobViaServer).toHaveBeenCalledWith(
      "music_model_download",
      // Params carry NO force flag — one identity for one output dir.
      {},
      expect.objectContaining({ forceNew: false, discardOutput: false }),
    );
  });

  it("status:'new' with forced:true marks data.forced and forwards forceNew", async () => {
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      status: "new",
      jobId: "job-forced",
      clientKey: "ck-forced",
      forced: true,
      result: { alreadyInstalled: false },
    } satisfies RunJobResult<{ alreadyInstalled: boolean }>);

    const r = await musicDownloadModel({ forceNew: true });
    expect(r.success).toBe(true);
    const d = r.data as MusicDownloadData;
    expect(d.status).toBe("installed");
    expect(d.jobId).toBe("job-forced");
    expect(d.forced).toBe(true);
    expect(runJobViaServer).toHaveBeenCalledWith(
      "music_model_download",
      {},
      expect.objectContaining({ forceNew: true, discardOutput: true }),
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
      result: { alreadyInstalled: false },
    } satisfies RunJobResult<{ alreadyInstalled: boolean }>);

    const r = await musicDownloadModel({});
    expect(r.success).toBe(true);
    const d = r.data as MusicDownloadData;
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

  it("status:'matching_completed' with a stale (cancelled/failed) job and no model on disk → status:'not_installed'", async () => {
    // beforeEach mocked isAceStepModelInstalled → false. The cached job did
    // not leave usable weights, so the tool must NOT claim "installed".
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      status: "matching_completed",
      existingJob: {
        jobId: "job-cached",
        pieceId: null,
        completedAt: "2026-05-20T12:00:00Z",
        status: "cancelled",
        result: undefined,
      },
    } satisfies RunJobResult<{ alreadyInstalled: boolean }>);

    const r = await musicDownloadModel({});
    expect(r.success).toBe(true);
    const d = r.data as MusicDownloadData;
    expect(d.status).toBe("not_installed");
    expect(d.matchedExisting).toBe(true);
    expect(d.hint).toMatch(/force/);
    expect(d.existingJob?.status).toBe("cancelled");
  });

  it("status:'matching_completed' with the model genuinely on disk → status:'installed'", async () => {
    // force:true reaches runJobViaServer even though the model is installed.
    const models = await import("@/lib/music/models");
    vi.spyOn(models, "isAceStepModelInstalled").mockReturnValue(true);
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      status: "matching_completed",
      existingJob: {
        jobId: "job-cached",
        pieceId: null,
        completedAt: "2026-05-20T12:00:00Z",
        status: "completed",
        result: { alreadyInstalled: true },
      },
    } satisfies RunJobResult<{ alreadyInstalled: boolean }>);

    const r = await musicDownloadModel({ force: true });
    expect(r.success).toBe(true);
    const d = r.data as MusicDownloadData;
    expect(d.status).toBe("installed");
    expect(d.matchedExisting).toBe(true);
    expect(d.hint).toBeUndefined();
  });
});
