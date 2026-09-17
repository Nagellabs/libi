import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runCategoryA,
  NODE_RUNTIME_PHASE_TIMEOUT_MS,
  nodeRuntimeProgressDetail,
} from "@/lib/server/lifecycle/category-a";
import { lifecycleEvents } from "@/lib/server/lifecycle/events";
import type { LifecycleEvent } from "@/lib/server/lifecycle/types";
import type { NodeRuntimeOutcome, NodeRuntimeProgress } from "@/lib/runtime/node-runtime";

describe("runCategoryA", () => {
  let events: LifecycleEvent[];
  let unsubscribe: () => void;

  beforeEach(() => {
    events = [];
    unsubscribe = lifecycleEvents.on((e) => events.push(e));
  });

  afterEach(() => {
    unsubscribe();
  });

  /** Fresh success by default — most tests here don't care about the node-runtime phase. */
  const okNodeRuntimeResult: NodeRuntimeOutcome = {
    ok: true,
    path: "/fake/bin/node",
    source: "already-managed",
  };
  const okNodeRuntime = async () => okNodeRuntimeResult;

  it("runs node-runtime then binary deps — nothing before, nothing after — and completes on success", async () => {
    const calls: string[] = [];
    await runCategoryA({
      installBinaryDeps: async () => { calls.push("binary"); },
      ensureNodeRuntime: async () => { calls.push("node-runtime"); return okNodeRuntimeResult; },
    });
    // node-runtime BEFORE binary: any custom installer that shells out to a
    // Node program resolves its interpreter through `resolveNodeCommand()`,
    // which returns bare `"node"` until this phase has put one at
    // `<LIBI_HOME>/bin/node`. On a machine whose only node lives in a version
    // manager — the common macOS case — a Finder-launched .app has none on
    // PATH, so (back when it was tier-1) Chromium's install failed on first
    // boot and only succeeded on the second.
    expect(calls).toEqual(["node-runtime", "binary"]);
    // The former phase 1 (bundled npm install) and phase 3 (in-memory MCP
    // probe) were deleted on 2026-09-08: the first had nothing left to
    // install, the second nothing left to probe. Neither may leave a trace —
    // and the probe EVENT KINDS went with them, so "no probe event"
    // is now enforced by `LifecycleEvent` itself rather than by an assertion.
    expect(events.some((e) => e.kind.startsWith("category-a-probe"))).toBe(false);
    expect(events.some((e) => e.kind === "category-a-install-start" && e.item.kind === "npm")).toBe(false);
    expect(events.some((e) => e.kind === "category-a-done")).toBe(true);
  });

  it("throws InstallPhaseError with hint when binary install fails", async () => {
    await expect(
      runCategoryA({
        installBinaryDeps: async () => { throw new Error("sha mismatch"); },
        ensureNodeRuntime: okNodeRuntime,
      }),
    ).rejects.toMatchObject({ name: "InstallPhaseError", step: "binary-install" });
  });

  it("does not install any agent adapter — that moved to agent selection", async () => {
    // Both adapters download when the user PICKS the agent
    // (the agent_install job), never at boot. Category A must neither call an
    // installer nor open a "Claude Code adapter" row on the splash.
    const calls: string[] = [];
    await runCategoryA({
      installBinaryDeps: async () => { calls.push("binary"); },
      ensureNodeRuntime: async () => { calls.push("node-runtime"); return okNodeRuntimeResult; },
    });
    expect(calls).toEqual(["node-runtime", "binary"]);
    expect(events.some((e) => e.kind === "category-a-install-start"
      && "item" in e && e.item.id === "claude-adapter")).toBe(false);
  });

  describe("the tier-1 set", () => {
    it("is exactly the libi core def, carrying only ffmpeg and ffprobe", async () => {
      const { BUNDLED_MCP_SERVERS } = await import("@/mcp/registry/bundled");
      const tier1 = BUNDLED_MCP_SERVERS.filter(
        (d) => (d.installFlow ?? "tier-1") === "tier-1",
      );
      expect(tier1.map((d) => d.id)).toEqual(["libi"]);
      expect(tier1[0]!.dependencies.map((d) => d.binary)).toEqual(["ffmpeg", "ffprobe"]);
    });

    it("has no tier-1-flagged dep hiding on a tier-2 parent", async () => {
      const { BUNDLED_MCP_SERVERS } = await import("@/mcp/registry/bundled");
      const strays = BUNDLED_MCP_SERVERS.flatMap((def) =>
        def.dependencies
          .filter((dep) => dep.installFlow === "tier-1")
          .map((dep) => `${def.id}/${dep.binary}`),
      );
      // A tier-1 dep on a tier-2 parent is what made Category B pre-warm
      // youtube-downloader and run `npx -y @kevinwatt/yt-dlp-mcp` on EVERY boot.
      expect(strays).toEqual([]);
    });

    it("keeps chromium and mediapipe-vision off the boot path", async () => {
      const { BUNDLED_MCP_SERVERS } = await import("@/mcp/registry/bundled");
      const bootBinaries = BUNDLED_MCP_SERVERS.filter(
        (d) => (d.installFlow ?? "tier-1") === "tier-1",
      ).flatMap((d) => d.dependencies.map((dep) => dep.binary));
      expect(bootBinaries).not.toContain("chromium");
      expect(bootBinaries).not.toContain("mediapipe-vision");
      expect(bootBinaries).not.toContain("uv");
      expect(bootBinaries).not.toContain("yt-dlp");
    });
  });

  describe("Node runtime phase (non-fatal)", () => {
    it("emits install-start/-progress/-done through lifecycleEvents on success", async () => {
      await runCategoryA({
        installBinaryDeps: async () => {},
        ensureNodeRuntime: async (onProgress) => {
          onProgress?.({ phase: "downloading", bytesDownloaded: 10, bytesTotal: 100 });
          onProgress?.({ phase: "extracting" });
          return { ok: true, path: "/fake/bin/node", source: "downloaded" };
        },
      });

      const start = events.find(
        (e) => e.kind === "category-a-install-start" && e.item.id === "node-runtime",
      );
      const progressEvents = events.filter(
        (e) => e.kind === "category-a-install-progress" && e.item.id === "node-runtime",
      );
      const done = events.find(
        (e) => e.kind === "category-a-install-done" && e.item.id === "node-runtime",
      );
      expect(start).toBeDefined();
      expect(progressEvents.length).toBeGreaterThanOrEqual(2);
      expect(progressEvents[0]).toMatchObject({ bytesDownloaded: 10, bytesTotal: 100 });
      expect(done).toMatchObject({ result: "installed" });
      // Category A still reaches its terminal success event — this phase
      // never blocks or aborts the rest of the sequence.
      expect(events.some((e) => e.kind === "category-a-done")).toBe(true);
    });

    it("reports 'skipped' (not 'installed') when a managed runtime already exists", async () => {
      await runCategoryA({
        installBinaryDeps: async () => {},
        ensureNodeRuntime: okNodeRuntime, // source: "already-managed"
      });
      const done = events.find(
        (e) => e.kind === "category-a-install-done" && e.item.id === "node-runtime",
      );
      expect(done).toMatchObject({ result: "skipped" });
    });

    it("opens NO row for an already-managed runtime — the start event is lazy", async () => {
      // `ensureNodeRuntime` decides `already-managed` from a filesystem check
      // and reports no progress, so an unconditional start flashed a
      // "downloading…" row on the splash for a runtime nothing fetched. The
      // skipped done event is the whole story.
      await runCategoryA({
        installBinaryDeps: async () => {},
        ensureNodeRuntime: okNodeRuntime,
      });
      expect(
        events.some((e) => e.kind === "category-a-install-start" && e.item.id === "node-runtime"),
      ).toBe(false);
      expect(
        events.some(
          (e) =>
            e.kind === "category-a-install-done" &&
            e.item.id === "node-runtime" &&
            e.result === "skipped",
        ),
      ).toBe(true);
    });

    it("opens the row on the FIRST progress tick, exactly once, before that tick", async () => {
      await runCategoryA({
        installBinaryDeps: async () => {},
        ensureNodeRuntime: async (onProgress) => {
          onProgress?.({ phase: "downloading", bytesDownloaded: 0, bytesTotal: 100 });
          onProgress?.({ phase: "downloading", bytesDownloaded: 50, bytesTotal: 100 });
          onProgress?.({ phase: "installing" });
          return { ok: true, path: "/fake/bin/node", source: "downloaded" };
        },
      });
      const nodeEvents = events.filter(
        (e) =>
          (e.kind === "category-a-install-start" ||
            e.kind === "category-a-install-progress" ||
            e.kind === "category-a-install-done") &&
          e.item.id === "node-runtime",
      );
      expect(nodeEvents.map((e) => e.kind)).toEqual([
        "category-a-install-start",
        "category-a-install-progress",
        "category-a-install-progress",
        "category-a-install-progress",
        "category-a-install-done",
      ]);
    });

    it("still opens a row when a failure follows real progress, and none when it does not", async () => {
      await runCategoryA({
        installBinaryDeps: async () => {},
        ensureNodeRuntime: async () => ({ ok: false, error: "network unreachable" }),
      });
      // Nothing was downloaded, so nothing announced a download. The `failed`
      // done event still reaches both renderers, which open a row for it.
      expect(
        events.some((e) => e.kind === "category-a-install-start" && e.item.id === "node-runtime"),
      ).toBe(false);
      expect(
        events.some(
          (e) =>
            e.kind === "category-a-install-done" &&
            e.item.id === "node-runtime" &&
            e.result === "failed",
        ),
      ).toBe(true);
    });

    it("does NOT throw and does NOT abort Category A when ensureNodeRuntime resolves { ok: false }", async () => {
      const calls: string[] = [];
      await expect(
        runCategoryA({
          installBinaryDeps: async () => { calls.push("binary"); },
          ensureNodeRuntime: async () => ({ ok: false, error: "no pinned build for this platform" }),
        }),
      ).resolves.toBeUndefined();

      // The binary phase (which runs AFTER this one) still ran — proof the
      // { ok: false } outcome didn't abort the sequence.
      expect(calls).toEqual(["binary"]);

      const done = events.find(
        (e) => e.kind === "category-a-install-done" && e.item.id === "node-runtime",
      );
      expect(done).toMatchObject({
        result: "failed",
        reason: "no pinned build for this platform",
      });
      expect(events.some((e) => e.kind === "fatal")).toBe(false);
      expect(events.some((e) => e.kind === "category-a-done")).toBe(true);
    });

    it("does NOT throw and does NOT abort Category A when ensureNodeRuntime itself throws unexpectedly", async () => {
      // ensureNodeRuntime() is documented to never throw, but this phase's
      // whole contract is "never brick boot" — prove the defense in depth
      // actually holds even if that contract is violated by a future bug.
      const calls: string[] = [];
      await expect(
        runCategoryA({
          installBinaryDeps: async () => { calls.push("binary"); },
          ensureNodeRuntime: async () => { throw new Error("unexpected throw"); },
        }),
      ).resolves.toBeUndefined();

      expect(calls).toEqual(["binary"]);
      const done = events.find(
        (e) => e.kind === "category-a-install-done" && e.item.id === "node-runtime",
      );
      expect(done).toMatchObject({ result: "failed", reason: "unexpected throw" });
      expect(events.some((e) => e.kind === "fatal")).toBe(false);
      expect(events.some((e) => e.kind === "category-a-done")).toBe(true);
    });

    it("bounds a stalled ensureNodeRuntime with a hard phase timeout instead of wedging boot (I2)", async () => {
      vi.useFakeTimers();
      try {
        const calls: string[] = [];
        const run = runCategoryA({
          installBinaryDeps: async () => { calls.push("binary"); },
          // Simulates a fetch() that never settles (e.g. a captive portal
          // swallowing the connection) — the phase's own withTimeout wrapper
          // must be what unblocks runCategoryA, not this promise resolving.
          ensureNodeRuntime: () => new Promise<never>(() => {}),
        });

        await vi.advanceTimersByTimeAsync(NODE_RUNTIME_PHASE_TIMEOUT_MS + 1_000);
        await run;

        // The rest of Category A still ran — the hang was bounded, not fatal.
        expect(calls).toEqual(["binary"]);
        const done = events.find(
          (e) => e.kind === "category-a-install-done" && e.item.id === "node-runtime",
        );
        expect(done).toMatchObject({ result: "failed" });
        expect(events.some((e) => e.kind === "fatal")).toBe(false);
        expect(events.some((e) => e.kind === "category-a-done")).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("nodeRuntimeProgressDetail", () => {
    it("describes each phase with human-readable, testable copy", () => {
      expect(nodeRuntimeProgressDetail({ phase: "linking" })).toMatch(/linking/i);
      expect(nodeRuntimeProgressDetail({ phase: "extracting" })).toMatch(/extracting/i);
      expect(nodeRuntimeProgressDetail({ phase: "installing" })).toMatch(/installing/i);
      expect(
        nodeRuntimeProgressDetail({ phase: "downloading", bytesDownloaded: 1024 * 1024, bytesTotal: null }),
      ).toBe("1.0MB");
      expect(
        nodeRuntimeProgressDetail({
          phase: "downloading",
          bytesDownloaded: 5 * 1024 * 1024,
          bytesTotal: 10 * 1024 * 1024,
        }),
      ).toBe("5.0MB / 10.0MB");
    });

    /**
     * Every surface renders this detail NEXT TO the item's own label —
     * the CLI as `Downloading ${label} (${detail})`, the splash as
     * `${label} — ${detail}` — so a detail that names the dependency read as
     * `Downloading Node.js runtime (downloading Node.js runtime — 12.8MB /
     * 49.7MB)` on the CLI and `Node.js runtime — downloading Node.js runtime
     * — 14.4MB / 49.7MB` on the packaged splash.
     */
    it("never names the dependency — the surfaces already print the label", () => {
      const phases: NodeRuntimeProgress[] = [
        { phase: "linking" },
        { phase: "extracting" },
        { phase: "installing" },
        { phase: "downloading", bytesDownloaded: 0, bytesTotal: null },
        { phase: "downloading", bytesDownloaded: 1024 * 1024, bytesTotal: null },
        { phase: "downloading", bytesDownloaded: 1024 * 1024, bytesTotal: 2 * 1024 * 1024 },
      ];
      for (const p of phases) {
        expect(nodeRuntimeProgressDetail(p)).not.toMatch(/node\.js runtime/i);
      }
    });

    /** The same misleading zero as the byte rows: no total and no bytes
     *  yet is "connecting", never "0.0MB". */
    it("does not render a zero byte count before the download has any", () => {
      expect(
        nodeRuntimeProgressDetail({ phase: "downloading", bytesDownloaded: 0, bytesTotal: null }),
      ).toBe("connecting");
    });
  });
});
