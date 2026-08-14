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
// Real `undici` Agent, mocked only so instances carry a `.close()` (called by
// `fetchFollowingVettedRedirects` after every hop) — otherwise every test
// here would throw the moment the guard's dispatcher gets closed. Instances
// are still real, distinct objects per call, which is exactly what the I1
// dispatcher-identity test below needs.
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
import { Agent } from "undici";
vi.mock("@/lib/ffmpeg/exec", () => ({
  runFfmpeg: vi.fn(),
  resolveFfmpegPath: vi.fn(() => "/usr/bin/ffmpeg"),
  resolveFfprobePath: vi.fn(() => "/usr/bin/ffprobe"),
}));
vi.mock("@/lib/ffmpeg/probe", () => ({
  probeMedia: vi.fn(async () => ({
    hasAudio: false,
    duration: 1,
    width: 640,
    height: 360,
  })),
}));
vi.mock("@/mcp/jobs-client", () => ({
  enqueueJobOnServer: vi.fn(async () => ({ jobId: "proxy-job-1", resumed: false })),
  logProxyGenEnqueueFailure: vi.fn(),
}));
vi.mock("@/lib/navigation-events", () => ({
  navigationEmitter: { emit: vi.fn() },
}));
// The SSRF guard resolves DNS now (lib/net/url-guard.ts); stub it so these
// tests don't depend on real network/DNS access. The one private-looking URL
// exercised below (169.254.169.254) is a literal IP and gets blocked before
// DNS is ever consulted, so a single "always public" answer is enough here.
vi.mock("node:dns", () => ({
  promises: { lookup: vi.fn(async () => [{ address: "203.0.113.10", family: 4 }]) },
}));

let tmp: string;

beforeEach(() => {
  __resetRunnerRegistryForTests();
  vi.mocked(Agent).mockClear();
  registerRunner(remoteFetchRunner as never);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-fetch-"));
  process.env.LIBI_HOME = tmp;
  fs.mkdirSync(path.join(tmp, "jobs"), { recursive: true });
  vi.mocked(getDb).mockReturnValue(createTestDb() as never);
  delete (globalThis as { __libiJobManager?: unknown }).__libiJobManager;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      }),
    ),
  );
});

afterEach(() => {
  delete process.env.LIBI_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("remoteFetchRunner", () => {
  it("downloads + stores each url as a piece file", async () => {
    const db = vi.mocked(getDb)();
    seedPiece(db as never, { id: "p", name: "p" });
    fs.mkdirSync(path.join(tmp, "storage", "p"), { recursive: true });

    const mgr = new JobManager();
    const jobId = jobIdOf(
      await mgr.enqueue("remote_fetch", {
        urls: ["https://storage.googleapis.com/demo/a.mp4"],
        pieceId: "p",
        autoUpload: true,
      }),
    );
    const result = await mgr.runToCompletion<RemoteFetchResult>(jobId);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].status).toBe("ok");
    expect(result.items[0].fileId).toBeTruthy();
  });

  it("marks a private url item as error without failing the batch", async () => {
    const db = vi.mocked(getDb)();
    seedPiece(db as never, { id: "p", name: "p" });
    fs.mkdirSync(path.join(tmp, "storage", "p"), { recursive: true });

    const mgr = new JobManager();
    // A second, public url succeeds so the batch is a PARTIAL failure — the
    // private-url item is still captured as an error (not throwing), while the
    // all-failed guard only fires when EVERY item errors.
    const jobId = jobIdOf(
      await mgr.enqueue("remote_fetch", {
        urls: [
          "http://169.254.169.254/x",
          "https://storage.googleapis.com/demo/ok.mp4",
        ],
        pieceId: "p",
        autoUpload: true,
      }),
    );
    const result = await mgr.runToCompletion<RemoteFetchResult>(jobId);
    expect(result.items[0].status).toBe("error");
    expect(result.items[0].error).toMatch(/blocked private address/);
  });

  it("rejects an oversized Content-Length before reading the body", async () => {
    const arrayBuffer = vi.fn();
    // The huge url reports an oversized Content-Length; a second small url
    // succeeds so the batch is a partial failure (the all-failed guard would
    // otherwise throw on a lone erroring url).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.includes("huge.mp4")
          ? {
              ok: true,
              status: 200,
              url: "https://example.com/huge.mp4",
              headers: new Headers({
                "content-type": "video/mp4",
                "content-length": String(600 * 1024 * 1024), // > 500 MB cap
              }),
              body: null,
              arrayBuffer,
            }
          : new Response(new Uint8Array([1, 2, 3]), {
              status: 200,
              headers: { "content-type": "video/mp4" },
            }),
      ),
    );

    const db = vi.mocked(getDb)();
    seedPiece(db as never, { id: "p", name: "p" });
    fs.mkdirSync(path.join(tmp, "storage", "p"), { recursive: true });

    const mgr = new JobManager();
    const jobId = jobIdOf(
      await mgr.enqueue("remote_fetch", {
        urls: [
          "https://example.com/huge.mp4",
          "https://example.com/small.mp4",
        ],
        pieceId: "p",
        autoUpload: true,
      }),
    );
    const result = await mgr.runToCompletion<RemoteFetchResult>(jobId);
    expect(result.items[0].status).toBe("error");
    expect(result.items[0].error).toMatch(/file too large/);
    // The body must never be touched when Content-Length already exceeds the cap.
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("marks an http-error url as error without failing the batch", async () => {
    // One url 404s, a second succeeds — a partial failure stays completed and
    // the 404 is captured as an error item (the all-failed guard needs EVERY
    // item to error before it throws).
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.includes("missing.mp4")
          ? new Response(null, { status: 404 })
          : new Response(new Uint8Array([1, 2, 3]), {
              status: 200,
              headers: { "content-type": "video/mp4" },
            }),
      ),
    );

    const db = vi.mocked(getDb)();
    seedPiece(db as never, { id: "p", name: "p" });
    fs.mkdirSync(path.join(tmp, "storage", "p"), { recursive: true });

    const mgr = new JobManager();
    const jobId = jobIdOf(
      await mgr.enqueue("remote_fetch", {
        urls: [
          "https://example.com/missing.mp4",
          "https://example.com/ok.mp4",
        ],
        pieceId: "p",
        autoUpload: true,
      }),
    );
    const result = await mgr.runToCompletion<RemoteFetchResult>(jobId);
    expect(result.items[0].status).toBe("error");
    expect(result.items[0].error).toMatch(/http 404/);
  });

  it("throws (job fails) when EVERY url fails", async () => {
    // Both urls 404 → every item errors → the runner must throw so the job fails.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    const db = vi.mocked(getDb)();
    seedPiece(db as never, { id: "p", name: "p" });
    fs.mkdirSync(path.join(tmp, "storage", "p"), { recursive: true });

    const mgr = new JobManager();
    const jobId = jobIdOf(
      await mgr.enqueue("remote_fetch", {
        urls: [
          "https://example.com/a.mp4",
          "https://example.com/b.mp4",
        ],
        pieceId: "p",
        autoUpload: true,
      }),
    );
    const runPromise = mgr.runToCompletion<RemoteFetchResult>(jobId);
    await expect(runPromise).rejects.toThrow(/all 2 downloads failed/i);
  });

  it("refuses an intermediate redirect hop that points at a private address, before that hop is ever fetched", async () => {
    // The initial url is public and 302s to a private/metadata address. If
    // only the start and the final res.url were checked, this hop would be
    // dereferenced before anything caught it. Per-hop validation must refuse
    // it BEFORE the second fetch() call happens at all.
    const fetchMock = vi.fn(async (input: string | URL) => {
      const href = typeof input === "string" ? input : input.toString();
      if (href.includes("public.example.com/redirect-me")) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      if (href.includes("ok.mp4")) {
        return new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "content-type": "video/mp4" },
        });
      }
      throw new Error(`unexpected fetch to ${href} — the private hop must never be dereferenced`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const db = vi.mocked(getDb)();
    seedPiece(db as never, { id: "p", name: "p" });
    fs.mkdirSync(path.join(tmp, "storage", "p"), { recursive: true });

    const mgr = new JobManager();
    const jobId = jobIdOf(
      await mgr.enqueue("remote_fetch", {
        urls: [
          "https://public.example.com/redirect-me",
          "https://storage.googleapis.com/demo/ok.mp4",
        ],
        pieceId: "p",
        autoUpload: true,
      }),
    );
    const result = await mgr.runToCompletion<RemoteFetchResult>(jobId);
    expect(result.items[0].status).toBe("error");
    expect(result.items[0].error).toMatch(/blocked private address/);
    expect(result.items[1].status).toBe("ok");
    // Exactly two fetches happened: the public first hop of each url. The
    // private redirect target (169.254.169.254) was never fetched.
    // The manager's own SSE notify hits the same stubbed global fetch, so
    // filter to just the urls this test cares about: the public first hop of
    // each download url must be fetched exactly once each, and the private
    // redirect target must never be fetched at all.
    const downloadCalls = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((href) => !href.includes("127.0.0.1"));
    expect(downloadCalls.filter((h) => h.includes("redirect-me"))).toHaveLength(1);
    expect(downloadCalls.filter((h) => h.includes("ok.mp4"))).toHaveLength(1);
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("169.254.169.254")),
    ).toBe(false);
  });

  it("stays completed on PARTIAL failure (one ok, one error)", async () => {
    // First url 200, second url 404 → partial failure stays completed.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) =>
        input.includes("ok.mp4")
          ? new Response(new Uint8Array([1, 2, 3]), {
              status: 200,
              headers: { "content-type": "video/mp4" },
            })
          : new Response(null, { status: 404 }),
      ),
    );

    const db = vi.mocked(getDb)();
    seedPiece(db as never, { id: "p", name: "p" });
    fs.mkdirSync(path.join(tmp, "storage", "p"), { recursive: true });

    const mgr = new JobManager();
    const jobId = jobIdOf(
      await mgr.enqueue("remote_fetch", {
        urls: [
          "https://example.com/ok.mp4",
          "https://example.com/missing.mp4",
        ],
        pieceId: "p",
        autoUpload: true,
      }),
    );
    const result = await mgr.runToCompletion<RemoteFetchResult>(jobId);
    expect(
      result.items.map((i: { status: string }) => i.status).sort(),
    ).toEqual(["error", "ok"]);
  });

  it("passes the guard's exact pinned dispatcher into fetch (I1 — proves the DNS-rebinding protection actually reaches the network call, not just that a URL string was checked)", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "content-type": "video/mp4" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const db = vi.mocked(getDb)();
    seedPiece(db as never, { id: "p", name: "p" });
    fs.mkdirSync(path.join(tmp, "storage", "p"), { recursive: true });

    const mgr = new JobManager();
    const jobId = jobIdOf(
      await mgr.enqueue("remote_fetch", {
        urls: ["https://storage.googleapis.com/demo/a.mp4"],
        pieceId: "p",
        autoUpload: true,
      }),
    );
    const result = await mgr.runToCompletion<RemoteFetchResult>(jobId);
    expect(result.items[0].status).toBe("ok");

    // Exactly one Agent was minted (one hop, no redirect) for the download —
    // the manager's own SSE notify hits the same stubbed global fetch but
    // never goes through the guard, so it never constructs an Agent.
    const AgentMock = vi.mocked(Agent);
    expect(AgentMock).toHaveBeenCalledTimes(1);
    const pinnedDispatcher = AgentMock.mock.instances[0];

    const downloadCall = fetchMock.mock.calls.find(([input]) =>
      String(input).includes("storage.googleapis.com"),
    );
    expect(downloadCall).toBeTruthy();
    const dispatcherArg = (
      downloadCall![1] as { dispatcher?: unknown } | undefined
    )?.dispatcher;
    // Not just "a dispatcher was present" — the SAME object instance the
    // guard's DNS-pinned Agent constructor produced. A mutation that dropped
    // `dispatcher` from the fetch() call entirely (I1's proof case) makes
    // this `undefined` and fails here.
    expect(dispatcherArg).toBe(pinnedDispatcher);
  });
});
