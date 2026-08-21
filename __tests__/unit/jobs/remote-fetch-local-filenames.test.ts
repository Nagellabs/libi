/**
 * `autoUpload: false` writes straight to `<LIBI_HOME>/tmp/remote-fetch/<jobId>/`
 * with a bare `path.join` + `writeFile` — no `storeFile`, and therefore none of
 * `dedupeFilename`'s collision handling. So the fallback name used for a url
 * with no basename (`https://host/`) has to be unique per item on its own.
 *
 * Nothing covered this branch before, which is exactly how a shared
 * `download.bin` fallback got proposed: the second download silently
 * overwrites the first, both items report the same `localPath`, and the first
 * item's `bytes` describes bytes that are no longer on disk.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTestDb, seedPiece } from "../../helpers/test-db";
import { jobIdOf } from "../../helpers/enqueue";
import { getDb } from "@/lib/db/client";
import { JobManager } from "@/lib/jobs/manager";
import {
  registerRunner,
  __resetRunnerRegistryForTests,
} from "@/lib/jobs/runners/registry";
import { remoteFetchRunner } from "@/lib/jobs/runners/remote-fetch";
import type { RemoteFetchResult } from "@/lib/jobs/runners/remote-fetch";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));
interface MockAgentInstance {
  __opts: unknown;
  close: () => Promise<void>;
}
vi.mock("undici", () => ({
  Agent: vi.fn(function MockAgent(this: MockAgentInstance, opts: unknown) {
    this.__opts = opts;
    this.close = vi.fn().mockResolvedValue(undefined);
  }),
}));
vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(async () => ({ jobId: "proxy-job-1", resumed: false })),
  logProxyGenEnqueueFailure: vi.fn(),
}));
vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { emit: vi.fn() },
}));
// The SSRF guard resolves DNS; stub it so this test needs no network.
vi.mock("node:dns", () => ({
  promises: { lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) },
}));

const BODY_A = new Uint8Array([1, 1, 1, 1]);
const BODY_B = new Uint8Array([2, 2]);

let tmp: string;

beforeEach(() => {
  __resetRunnerRegistryForTests();
  registerRunner(remoteFetchRunner as never);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-fetch-names-"));
  process.env.LIBI_HOME = tmp;
  fs.mkdirSync(path.join(tmp, "jobs"), { recursive: true });
  vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("remoteFetchRunner — local filenames (autoUpload: false)", () => {
  it("gives two basename-less urls DISTINCT local paths, so neither overwrites the other", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) =>
        String(input).includes("a.example.com")
          ? new Response(BODY_A, {
              status: 200,
              headers: { "content-type": "video/mp4" },
            })
          : new Response(BODY_B, {
              status: 200,
              headers: { "content-type": "video/mp4" },
            }),
      ),
    );

    const db = vi.mocked(getDb)();
    seedPiece(db as never, { id: "p", name: "p" });

    const mgr = new JobManager();
    const jobId = jobIdOf(
      await mgr.enqueue("remote_fetch", {
        // Neither url has a basename — both fall back.
        urls: ["https://a.example.com/", "https://b.example.com/"],
        pieceId: "p",
        autoUpload: false,
      }),
    );
    const result = await mgr.runToCompletion<RemoteFetchResult>(jobId);

    expect(result.items.map((i) => i.status)).toEqual(["ok", "ok"]);
    const paths = result.items.map((i) => i.localPath!);
    expect(new Set(paths).size).toBe(2);
    expect(paths.map((p) => path.basename(p))).toEqual([
      "download-0.bin",
      "download-1.bin",
    ]);

    // Both files exist AND each still holds its own bytes — the assertion a
    // shared fallback name breaks, since the survivor would carry B's body
    // while item 0 reports 4 bytes.
    expect(fs.readFileSync(paths[0])).toEqual(Buffer.from(BODY_A));
    expect(fs.readFileSync(paths[1])).toEqual(Buffer.from(BODY_B));
    expect(result.items[0].bytes).toBe(BODY_A.byteLength);
    expect(result.items[1].bytes).toBe(BODY_B.byteLength);
  });

  it("still uses the url's own basename when there is one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(BODY_A, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
      ),
    );

    const db = vi.mocked(getDb)();
    seedPiece(db as never, { id: "p", name: "p" });

    const mgr = new JobManager();
    const jobId = jobIdOf(
      await mgr.enqueue("remote_fetch", {
        urls: ["https://storage.googleapis.com/demo/clip-hero.mp4"],
        pieceId: "p",
        autoUpload: false,
      }),
    );
    const result = await mgr.runToCompletion<RemoteFetchResult>(jobId);
    expect(result.items[0].status).toBe("ok");
    expect(path.basename(result.items[0].localPath!)).toBe("clip-hero.mp4");
  });
});
