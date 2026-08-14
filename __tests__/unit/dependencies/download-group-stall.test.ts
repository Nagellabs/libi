/**
 * Task #54 — DependencyManager-level proof that a stalled dependency
 * download FAILS FAST with an actionable error instead of hanging Category
 * A's first boot forever.
 *
 * This drives the REAL `downloadGroup` path (the one `installBundledDeps` /
 * `ensureMcp` / `retryDep` all funnel into), including the production
 * `fetchWithHttpsOnlyRedirects` transport. The `global.fetch` shim only
 * rewrites the https:// host to a local plain-HTTP stall server — the
 * HTTPS-only URL check, manual-redirect loop, and AbortSignal plumbing all
 * execute for real.
 *
 * Before the fix, the stall test hung on the silent socket until the vitest
 * timeout killed it — that hang IS the shipped bug (8+ minutes at 0.0% CPU
 * on a clean-home packaged boot).
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

vi.mock("@/lib/db/client", () => ({ getDb: vi.fn() }));

import { DependencyManager, type BinaryInstallProgress } from "@/mcp/registry/dependency-manager";
import {
  startStallServer,
  type StallServer,
  OK_BODY,
} from "../../helpers/stall-server";

const FAKE_HTTPS_ORIGIN = "https://stall.example";

let server: StallServer;
let realFetch: typeof fetch;
let tmpHome: string;
let savedHome: string | undefined;

beforeAll(async () => {
  server = await startStallServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(() => {
  savedHome = process.env.LIBI_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-dlstall-"));
  fs.mkdirSync(path.join(tmpHome, "bin"), { recursive: true });
  process.env.LIBI_HOME = tmpHome;

  // Small, deterministic guard values so the failure path completes in ~1.5s
  // (150ms idle × 2 attempts + 1s backoff) instead of the production 30s×3.
  process.env.LIBI_DOWNLOAD_IDLE_TIMEOUT_MS = "150";
  process.env.LIBI_DOWNLOAD_MAX_ATTEMPTS = "2";

  realFetch = globalThis.fetch;
  // Keep production HTTPS enforcement honest: the URL handed to
  // fetchWithHttpsOnlyRedirects stays https://; only the socket target is
  // rewritten to the loopback stall server.
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith(FAKE_HTTPS_ORIGIN)) {
      return realFetch(url.replace(FAKE_HTTPS_ORIGIN, server.origin), init);
    }
    return realFetch(input as string, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.LIBI_DOWNLOAD_IDLE_TIMEOUT_MS;
  delete process.env.LIBI_DOWNLOAD_MAX_ATTEMPTS;
  if (savedHome === undefined) delete process.env.LIBI_HOME;
  else process.env.LIBI_HOME = savedHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const fakeDep = { binary: "fakebin", downloadUrl: `${FAKE_HTTPS_ORIGIN}/unused` };

describe("DependencyManager.downloadGroup stall guard", () => {
  it(
    "a stalled download rejects in bounded time with an actionable error (pre-fix: hung forever)",
    { timeout: 10_000 },
    async () => {
      const manager = new DependencyManager();
      const progress: Array<Pick<BinaryInstallProgress, "status" | "bytesDownloaded" | "bytesTotal" | "detail">> = [];

      const started = Date.now();
      let caught: unknown;
      try {
        await (manager as unknown as {
          downloadGroup: (
            url: string,
            deps: unknown[],
            onProgress?: (p: (typeof progress)[number]) => void,
          ) => Promise<void>;
        }).downloadGroup(`${FAKE_HTTPS_ORIGIN}/stall-mid-body`, [fakeDep], (p) =>
          progress.push({ ...p }),
        );
      } catch (err) {
        caught = err;
      }
      const elapsed = Date.now() - started;

      // Bounded: 2 attempts × 150ms idle + 1s backoff ≪ 10s. The pre-fix
      // code never rejected at all.
      expect(caught).toBeInstanceOf(Error);
      expect(elapsed).toBeLessThan(8_000);

      const message = (caught as Error).message;
      expect(message).toContain("fakebin"); // which dependency
      expect(message).toContain("stall.example"); // which host
      expect(message).toContain(`${FAKE_HTTPS_ORIGIN}/stall-mid-body`); // URL
      expect(message).toMatch(/2 attempts/);
      expect(message).toMatch(/no data received/);

      // The retry was VISIBLE on the progress stream (→ CLI spinner + splash).
      const retryTick = progress.find((p) => p.detail?.includes("retrying"));
      expect(retryTick?.detail).toContain("download stalled — retrying (attempt 2 of 2)");

      // Nothing half-written into bin/.
      expect(fs.existsSync(path.join(tmpHome, "bin", "fakebin"))).toBe(false);

      // Both attempts actually hit the server.
      expect(server.hits.get("/stall-mid-body")).toBe(2);
    },
  );

  it("a healthy download still installs the raw binary", async () => {
    const manager = new DependencyManager();
    const progress: Array<Pick<BinaryInstallProgress, "status" | "bytesDownloaded" | "bytesTotal">> = [];

    await (manager as unknown as {
      downloadGroup: (
        url: string,
        deps: unknown[],
        onProgress?: (p: (typeof progress)[number]) => void,
      ) => Promise<void>;
    }).downloadGroup(`${FAKE_HTTPS_ORIGIN}/ok`, [fakeDep], (p) => progress.push({ ...p }));

    const binPath = path.join(tmpHome, "bin", "fakebin");
    expect(fs.readFileSync(binPath).equals(OK_BODY)).toBe(true);
    if (process.platform !== "win32") {
      expect(fs.statSync(binPath).mode & 0o755).toBe(0o755);
    }
    const last = progress.filter((p) => p.status === "downloading").pop();
    expect(last?.bytesDownloaded).toBe(OK_BODY.length);
  });
});
