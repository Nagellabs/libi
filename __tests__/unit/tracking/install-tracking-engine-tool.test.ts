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
      result: { alreadyInstalled: false },
    })),
  };
});

import { runJobViaServer } from "@/mcp/jobs-client";
import { installTrackingEngine } from "@/mcp/tools/tracking-tools";
import { trackingModelsDir } from "@/lib/tracking/engine-deps";

/** Write the on-disk install token the trackingEngineInstalled() gate reads. */
function writeInstallToken() {
  const dir = trackingModelsDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ".install-token"), "ok");
}

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ite-"));
  process.env.LIBI_HOME = tmp;
});
afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/** The shape installTrackingEngine puts in `data` — narrowed from the
 *  generic result for the shape-contract assertions below. */
type InstallData = {
  status: string;
  jobId?: string;
  clientKey?: string;
  forced?: boolean;
  attachedToRunning?: boolean;
  matchedExisting?: boolean;
  hint?: string;
  existingJob?: { jobId: string; status?: string };
};

describe("installTrackingEngine", () => {
  it("short-circuits when the engine is already installed (no job)", async () => {
    writeInstallToken();
    const res = await installTrackingEngine({});
    expect(res.success).toBe(true);
    const d = (res as { data: InstallData }).data;
    expect(d.status).toBe("already_installed");
    expect(runJobViaServer).not.toHaveBeenCalled();
  });

  it("refuses in test mode WITHOUT enqueueing", async () => {
    vi.stubEnv("LIBI_TEST_MODE", "1");
    const res = await installTrackingEngine({});
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toBe("test_mode_no_real_install");
    const d = (res as { data: { hint: string } }).data;
    // The refusal must explain this is a real install test mode cannot fake.
    expect(d.hint).toMatch(/test mode/i);
    expect(d.hint).toMatch(/2\s?GB/i);
    expect(runJobViaServer).not.toHaveBeenCalled();
  });

  it("runs the job when absent: kind, empty params, forceNew:false, no discardOutput", async () => {
    const res = await installTrackingEngine({});
    expect(runJobViaServer).toHaveBeenCalledTimes(1);
    const [kind, params, opts] = vi.mocked(runJobViaServer).mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(kind).toBe("tracking_engine_install");
    // One install, one paramsHash — force must never ride on params.
    expect(params).toEqual({});
    expect(opts.forceNew).toBe(false);
    // Tracking artifacts are sha-verified + token-written-last: there are
    // never suspect bytes to discard. This must stay unset even on force.
    expect(opts).not.toHaveProperty("discardOutput");
    expect(res.success).toBe(true);
    const d = (res as { data: InstallData }).data;
    expect(d.status).toBe("installed");
    expect(d.jobId).toBe("job-1");
    expect(d.hint).toMatch(/verify_install/);
  });

  it("force:true bypasses the installed short-circuit and reaches enqueue opts as forceNew", async () => {
    writeInstallToken();
    const res = await installTrackingEngine({ force: true });
    expect(runJobViaServer).toHaveBeenCalledTimes(1);
    const [kind, params, opts] = vi.mocked(runJobViaServer).mock.calls[0] as [
      string,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(kind).toBe("tracking_engine_install");
    expect(params).toEqual({});
    expect(opts.forceNew).toBe(true);
    expect(opts).not.toHaveProperty("discardOutput");
    expect(res.success).toBe(true);
  });

  it("attached_running surfaces attachedToRunning + existingJob and still points at verify_install", async () => {
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      status: "attached_running",
      jobId: "job-att",
      clientKey: "ck-att",
      existingJob: {
        jobId: "job-orig",
        pieceId: null,
        startedAt: "2026-08-22T10:00:00Z",
      },
      result: { alreadyInstalled: false },
    });
    const res = await installTrackingEngine({});
    expect(res.success).toBe(true);
    const d = (res as { data: InstallData }).data;
    expect(d.status).toBe("installed");
    expect(d.attachedToRunning).toBe(true);
    expect(d.existingJob!.jobId).toBe("job-orig");
    expect(d.hint).toMatch(/verify_install/);
  });

  it("matching_completed with no engine on disk re-checks the DISK → not_installed + force hint", async () => {
    // A cached terminal job row (even "completed") is not authoritative —
    // no install token on disk means no usable engine.
    vi.mocked(runJobViaServer).mockResolvedValueOnce({
      status: "matching_completed",
      existingJob: {
        jobId: "job-cached",
        pieceId: null,
        completedAt: "2026-08-20T12:00:00Z",
        status: "cancelled",
        result: undefined,
      },
    });
    const res = await installTrackingEngine({});
    expect(res.success).toBe(true);
    const d = (res as { data: InstallData }).data;
    expect(d.status).toBe("not_installed");
    expect(d.matchedExisting).toBe(true);
    expect(d.existingJob!.status).toBe("cancelled");
    expect(d.hint).toMatch(/force/);
  });

  it("matching_completed with the engine on disk → installed + verify_install hint", async () => {
    vi.mocked(runJobViaServer).mockImplementationOnce(async () => {
      // Token appears "during" the job lookup — simulates a genuine prior
      // completed install whose row was cached.
      writeInstallToken();
      return {
        status: "matching_completed",
        existingJob: {
          jobId: "job-cached",
          pieceId: null,
          completedAt: "2026-08-20T12:00:00Z",
          status: "completed",
          result: { alreadyInstalled: true },
        },
      };
    });
    const res = await installTrackingEngine({});
    expect(res.success).toBe(true);
    const d = (res as { data: InstallData }).data;
    expect(d.status).toBe("installed");
    expect(d.matchedExisting).toBe(true);
    expect(d.hint).toMatch(/verify_install/);
  });

  it("maps LibiServerUnavailableError to the structured unavailable result", async () => {
    const { LibiServerUnavailableError } = await import("@/mcp/jobs-client");
    vi.mocked(runJobViaServer).mockRejectedValueOnce(
      new LibiServerUnavailableError("down", "start libi"),
    );
    const res = await installTrackingEngine({});
    expect(res.success).toBe(false);
    expect((res as { error: string }).error).toBe("libi_server_unavailable");
  });
});
