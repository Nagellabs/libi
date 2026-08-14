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

import { runJobViaServer } from "@/mcp/jobs-client";
import { ttsDownloadModel } from "@/mcp/tools/tts-tools";

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-tts-dl-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.clearAllMocks();
});

describe("ttsDownloadModel short-circuit", () => {
  it("returns already_installed when the model is on disk", async () => {
    // Make model appear installed.
    const voices = await import("@/lib/tts/voices");
    vi.spyOn(voices, "isKokoroModelInstalled").mockReturnValue(true);

    const r = await ttsDownloadModel({});
    expect(r.success).toBe(true);
    expect(r.data?.status).toBe("already_installed");
    expect(runJobViaServer).not.toHaveBeenCalled();
  });
});

describe("ttsDownloadModel RunJobResult shapes", () => {
  beforeEach(async () => {
    // Ensure runJobViaServer is exercised (model not installed).
    const voices = await import("@/lib/tts/voices");
    vi.spyOn(voices, "isKokoroModelInstalled").mockReturnValue(false);
  });

  it("status:'new' surfaces jobId + clientKey, no dedup markers", async () => {
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      status: "new",
      jobId: "job-new",
      clientKey: "ck-new",
      result: { alreadyInstalled: false },
    });

    const r = await ttsDownloadModel({});
    expect(r.success).toBe(true);
    const d = r.data ?? {};
    expect(d.status).toBe("installed");
    expect(d.jobId).toBe("job-new");
    expect(d.clientKey).toBe("ck-new");
    expect(d.attachedToRunning).toBeUndefined();
    expect(d.matchedExisting).toBeUndefined();
    expect(runJobViaServer).toHaveBeenCalledWith(
      "tts_model_download",
      {},
      expect.objectContaining({ forceNew: false }),
    );
  });

  it("status:'new' with forced:true marks data.forced and forwards forceNew", async () => {
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      status: "new",
      jobId: "job-forced",
      clientKey: "ck-forced",
      forced: true,
      result: { alreadyInstalled: false },
    });

    const r = await ttsDownloadModel({ forceNew: true });
    expect(r.success).toBe(true);
    const d = r.data ?? {};
    expect(d.status).toBe("installed");
    expect(d.jobId).toBe("job-forced");
    expect(d.forced).toBe(true);
    expect(runJobViaServer).toHaveBeenCalledWith(
      "tts_model_download",
      {},
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
      result: { alreadyInstalled: false },
    });

    const r = await ttsDownloadModel({});
    expect(r.success).toBe(true);
    const d = r.data ?? {};
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
    // beforeEach mocked isKokoroModelInstalled → false. Reaching this branch
    // means the model is genuinely absent — the tool must not claim "installed".
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

    const r = await ttsDownloadModel({});
    expect(r.success).toBe(true);
    const d = r.data as { status?: string; matchedExisting?: boolean; hint?: string; existingJob?: { status?: string } };
    expect(d.status).toBe("not_installed");
    expect(d.matchedExisting).toBe(true);
    expect(d.hint).toMatch(/forceNew/);
    expect(d.existingJob?.status).toBe("cancelled");
  });
});
