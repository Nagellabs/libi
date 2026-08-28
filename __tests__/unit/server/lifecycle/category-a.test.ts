import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  runCategoryA,
  InstallPhaseError,
  defaultCategoryADeps,
  NODE_RUNTIME_PHASE_TIMEOUT_MS,
  nodeRuntimeProgressDetail,
} from "@/lib/server/lifecycle/category-a";
import { lifecycleEvents } from "@/lib/server/lifecycle/events";
import type { BundledMcpDef } from "@/mcp/registry/types";
import type { LifecycleEvent } from "@/lib/server/lifecycle/types";
import type { NodeRuntimeOutcome } from "@/lib/runtime/node-runtime";
import { getManagedBundledNpmMcps } from "@/lib/mcp/bundled-install";

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

  const fakeDef: BundledMcpDef = {
    id: "fake-mcp",
    name: "Fake MCP",
    description: "",
    npmUrl: null,
    type: "stdio",
    command: "echo",
    args: [],
    requireApproval: false,
    dependencies: [],
  };

  /** Fresh success by default — most tests here don't care about the adapter phase. */
  const okClaudeAdapter = async () => ({ installed: true, binPath: "/fake/claude-agent-acp" });

  /** Fresh success by default — most tests here don't care about the node-runtime phase. */
  const okNodeRuntimeResult: NodeRuntimeOutcome = {
    ok: true,
    path: "/fake/bin/node",
    source: "already-managed",
  };
  const okNodeRuntime = async () => okNodeRuntimeResult;

  it("runs install + binary + node-runtime + adapter + probe in order and completes on success", async () => {
    const calls: string[] = [];
    await runCategoryA({
      ensureBundledNpm: async () => { calls.push("npm"); },
      installBinaryDeps: async () => { calls.push("binary"); },
      probeMcp: async () => { calls.push("probe"); return { status: "up", error: null, durationMs: 5 }; },
      defs: () => [fakeDef],
      ensureNodeRuntime: async () => { calls.push("node-runtime"); return okNodeRuntimeResult; },
      ensureClaudeAdapter: async () => { calls.push("claude-adapter"); return okClaudeAdapter(); },
    });
    // This ordering assertion is the whole point: it would NOT have caught the
    // node-runtime phase being wired to the wrong slot in the sequence (it was
    // simply absent from this list before), only that npm/binary/adapter/probe
    // ran in order. Asserting its exact position here is what makes a misplaced
    // phase (e.g. after probing) a red test.
    //
    // node-runtime BEFORE binary: the `playwright-chromium` installer (and any
    // other custom installer that shells out to a Node program) resolves its
    // interpreter through `resolveNodeCommand()`, which returns bare `"node"`
    // until this phase has put one at `<LIBI_HOME>/bin/node`. On a machine
    // whose only node lives in a version manager — the common macOS case — a
    // Finder-launched .app has none on PATH, so Chromium's install failed on
    // first boot and only succeeded on the second.
    expect(calls).toEqual(["npm", "node-runtime", "binary", "claude-adapter", "probe"]);
    expect(events.some((e) => e.kind === "category-a-probe-done" && e.status === "up")).toBe(true);
    expect(events.some((e) => e.kind === "category-a-done")).toBe(true);
  });

  it("throws InstallPhaseError with hint when npm install fails", async () => {
    await expect(
      runCategoryA({
        ensureBundledNpm: async () => { throw new Error("ENETUNREACH"); },
        installBinaryDeps: async () => {},
        probeMcp: async () => ({ status: "up", error: null, durationMs: 0 }),
        defs: () => [],
        ensureNodeRuntime: okNodeRuntime,
        ensureClaudeAdapter: okClaudeAdapter,
      }),
    ).rejects.toMatchObject({ name: "InstallPhaseError", step: "npm-install" });
  });

  it("throws InstallPhaseError with hint when binary install fails", async () => {
    await expect(
      runCategoryA({
        ensureBundledNpm: async () => {},
        installBinaryDeps: async () => { throw new Error("sha mismatch"); },
        probeMcp: async () => ({ status: "up", error: null, durationMs: 0 }),
        defs: () => [],
        ensureNodeRuntime: okNodeRuntime,
        ensureClaudeAdapter: okClaudeAdapter,
      }),
    ).rejects.toMatchObject({ name: "InstallPhaseError", step: "binary-install" });
  });

  it("throws InstallPhaseError when an MCP probe returns down", async () => {
    await expect(
      runCategoryA({
        ensureBundledNpm: async () => {},
        installBinaryDeps: async () => {},
        probeMcp: async () => ({ status: "down", error: "boom", durationMs: 10 }),
        defs: () => [fakeDef],
        ensureNodeRuntime: okNodeRuntime,
        ensureClaudeAdapter: okClaudeAdapter,
      }),
    ).rejects.toMatchObject({ name: "InstallPhaseError", step: "probe:fake-mcp" });
  });

  it("skips probes for MCPs with required env vars that aren't set", async () => {
    const calls: string[] = [];
    await runCategoryA({
      ensureBundledNpm: async () => {},
      installBinaryDeps: async () => {},
      probeMcp: async () => { calls.push("probe"); return { status: "up", error: null, durationMs: 0 }; },
      defs: () => [{ ...fakeDef, requiredEnvVars: ["API_KEY"] }],
      ensureNodeRuntime: okNodeRuntime,
      ensureClaudeAdapter: okClaudeAdapter,
    });
    expect(calls).toEqual([]);
    expect(events.some((e) => e.kind === "category-a-probe-done" && e.status === "skipped" && e.reason === "needs_config")).toBe(true);
  });

  describe("Claude adapter phase (non-fatal)", () => {
    it("reports progress through lifecycleEvents on success", async () => {
      await runCategoryA({
        ensureBundledNpm: async () => {},
        installBinaryDeps: async () => {},
        probeMcp: async () => ({ status: "up", error: null, durationMs: 0 }),
        defs: () => [],
        ensureNodeRuntime: okNodeRuntime,
        ensureClaudeAdapter: async () => ({ installed: true, binPath: "/fake/bin/claude-agent-acp" }),
      });

      const start = events.find(
        (e) => e.kind === "category-a-install-start" && e.item.id === "claude-adapter",
      );
      const done = events.find(
        (e) => e.kind === "category-a-install-done" && e.item.id === "claude-adapter",
      );
      expect(start).toBeDefined();
      expect(done).toMatchObject({ result: "installed" });
      // Category A still reaches its terminal success event — the adapter
      // phase never blocks or aborts the rest of the sequence.
      expect(events.some((e) => e.kind === "category-a-done")).toBe(true);
    });

    it("emits elapsed-time progress so the largest download in Category A isn't silent", async () => {
      // The adapter install is a single opaque `npm install` (~250MB) that can
      // legitimately run for minutes behind a slow link. Without a tick the
      // splash sits motionless on "running", which reads as a hang — and a
      // force-quit mid-download is exactly what leaves the half-installed tree
      // that lib/agents/claude-native-binary.ts exists to detect.
      await runCategoryA({
        ensureBundledNpm: async () => {},
        installBinaryDeps: async () => {},
        probeMcp: async () => ({ status: "up", error: null, durationMs: 0 }),
        defs: () => [],
        ensureNodeRuntime: okNodeRuntime,
        ensureClaudeAdapter: async () => ({ installed: true, binPath: "/fake/bin/claude-agent-acp" }),
      });

      const ticks = events.filter(
        (e) => e.kind === "category-a-install-progress" && e.item.id === "claude-adapter",
      );
      // At least the immediate one — a fast install must still show progress.
      expect(ticks.length).toBeGreaterThan(0);
      const detail = (ticks[0] as { detail?: string }).detail ?? "";
      // The two facts that separate "working" from "hung" for the user.
      expect(detail).toContain("345 MB");
      expect(detail).toContain("first run only");
      expect(detail).toMatch(/elapsed/);
    });

    it("formats the tick detail with size, once-only framing, and elapsed time", async () => {
      const { claudeAdapterProgressDetail } = await import(
        "@/lib/server/lifecycle/category-a"
      );
      expect(claudeAdapterProgressDetail(0)).toContain("0s elapsed");
      expect(claudeAdapterProgressDetail(45_000)).toContain("45s elapsed");
      expect(claudeAdapterProgressDetail(125_000)).toContain("2m 5s elapsed");
      expect(claudeAdapterProgressDetail(125_000)).toContain("downloading ~345 MB, first run only");
    });

    it("keeps ticking while npm runs, and stops the moment the phase ends", async () => {
      const { CLAUDE_ADAPTER_TICK_MS } = await import("@/lib/server/lifecycle/category-a");
      const ticks = () =>
        events.filter((e) => e.kind === "category-a-install-progress").length;

      vi.useFakeTimers();
      try {
        let release!: () => void;
        const npmInFlight = new Promise<void>((resolve) => { release = resolve; });
        const run = runCategoryA({
          ensureBundledNpm: async () => {},
          installBinaryDeps: async () => {},
          probeMcp: async () => ({ status: "up", error: null, durationMs: 0 }),
          defs: () => [],
          ensureNodeRuntime: okNodeRuntime,
          ensureClaudeAdapter: async () => {
            await npmInFlight;
            return { installed: true, binPath: "/fake/bin/claude-agent-acp" };
          },
        });

        await vi.advanceTimersByTimeAsync(0);
        const atStart = ticks();
        expect(atStart).toBeGreaterThan(0); // immediate first tick

        await vi.advanceTimersByTimeAsync(CLAUDE_ADAPTER_TICK_MS * 3);
        // A long install keeps showing movement rather than freezing.
        expect(ticks()).toBeGreaterThan(atStart);

        release();
        await run;
        const atEnd = ticks();
        await vi.advanceTimersByTimeAsync(CLAUDE_ADAPTER_TICK_MS * 3);
        // A leaked interval would keep rewriting the splash subtitle (and the
        // CLI spinner) long after the phase reported done.
        expect(ticks()).toBe(atEnd);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does NOT throw and does NOT abort Category A when the adapter install fails", async () => {
      const calls: string[] = [];
      await expect(
        runCategoryA({
          ensureBundledNpm: async () => { calls.push("npm"); },
          installBinaryDeps: async () => { calls.push("binary"); },
          probeMcp: async () => { calls.push("probe"); return { status: "up", error: null, durationMs: 0 }; },
          defs: () => [fakeDef],
          ensureNodeRuntime: okNodeRuntime,
          ensureClaudeAdapter: async () => ({
            installed: false,
            binPath: null,
            error: "registry unreachable: ENOTFOUND registry.npmjs.org",
          }),
        }),
      ).resolves.toBeUndefined();

      // The probe phase (which runs AFTER the adapter phase) still ran —
      // proof the failure didn't abort the sequence.
      expect(calls).toEqual(["npm", "binary", "probe"]);

      const done = events.find(
        (e) => e.kind === "category-a-install-done" && e.item.id === "claude-adapter",
      );
      expect(done).toMatchObject({
        result: "failed",
        reason: "registry unreachable: ENOTFOUND registry.npmjs.org",
      });
      // No fatal event — a real observable proof this never became an
      // InstallPhaseError.
      expect(events.some((e) => e.kind === "fatal")).toBe(false);
      expect(events.some((e) => e.kind === "category-a-done")).toBe(true);
    });

    it("does NOT report the adapter as newly installed when the upgrade failed and the old tree was kept", async () => {
      // `installed: true` with `upgradeError` set means: usable, but still on
      // the version the user already had. Reporting "installed" here makes a
      // pin bump that reached nobody look exactly like one that reached
      // everybody. It is still not a failure — the adapter runs — so the boot
      // UI must not warn a user whose Claude Code works.
      const calls: string[] = [];
      await expect(
        runCategoryA({
          ensureBundledNpm: async () => { calls.push("npm"); },
          installBinaryDeps: async () => { calls.push("binary"); },
          probeMcp: async () => { calls.push("probe"); return { status: "up", error: null, durationMs: 0 }; },
          defs: () => [fakeDef],
          ensureNodeRuntime: okNodeRuntime,
          ensureClaudeAdapter: async () => ({
            installed: true,
            binPath: "/fake/bin/claude-agent-acp",
            staleVersion: "0.44.0",
            upgradeError: "npm ERR! code ENOTFOUND registry.npmjs.org",
          }),
        }),
      ).resolves.toBeUndefined();

      // Phase 2.5 stays non-fatal: the rest of Category A still ran.
      expect(calls).toEqual(["npm", "binary", "probe"]);
      const done = events.find(
        (e) => e.kind === "category-a-install-done" && e.item.id === "claude-adapter",
      );
      expect(done).toMatchObject({ result: "skipped" });
      expect((done as { reason?: string }).reason).toContain("0.44.0");
      expect(events.some((e) => e.kind === "fatal")).toBe(false);
      expect(events.some((e) => e.kind === "category-a-done")).toBe(true);
    });

    it("does NOT throw and does NOT abort Category A when ensureClaudeAdapter itself throws unexpectedly", async () => {
      // ensureClaudeAdapterInstalled() is documented to never throw, but this
      // phase's whole contract is "never brick boot" — prove the defense in
      // depth actually holds even if that contract is violated by a future bug.
      const calls: string[] = [];
      await expect(
        runCategoryA({
          ensureBundledNpm: async () => { calls.push("npm"); },
          installBinaryDeps: async () => { calls.push("binary"); },
          probeMcp: async () => { calls.push("probe"); return { status: "up", error: null, durationMs: 0 }; },
          defs: () => [fakeDef],
          ensureNodeRuntime: okNodeRuntime,
          ensureClaudeAdapter: async () => { throw new Error("unexpected throw"); },
        }),
      ).resolves.toBeUndefined();

      expect(calls).toEqual(["npm", "binary", "probe"]);
      const done = events.find(
        (e) => e.kind === "category-a-install-done" && e.item.id === "claude-adapter",
      );
      expect(done).toMatchObject({ result: "failed", reason: "unexpected throw" });
      expect(events.some((e) => e.kind === "fatal")).toBe(false);
      expect(events.some((e) => e.kind === "category-a-done")).toBe(true);
    });
  });

  describe("tier-2 install filtering", () => {
    it("defaultCategoryADeps.defs() returns only tier-1 (no youtube-downloader, elevenlabs, fal-ai)", () => {
      const defs = defaultCategoryADeps.defs();
      const ids = defs.map((d) => d.id);
      // Tier-1 should still be present
      expect(ids).toContain("libi");
      // Tier-2 should NOT be installed by Category A
      expect(ids).not.toContain("youtube-downloader");
      expect(ids).not.toContain("elevenlabs");
      expect(ids).not.toContain("fal-ai");
      // Sanity: every returned def is tier-1 (default) — no installFlow=tier-2
      for (const def of defs) {
        expect(def.installFlow ?? "tier-1").toBe("tier-1");
      }
    });

    it("getManagedBundledNpmMcps() excludes tier-2 npm packages (yt-dlp-mcp, elevenlabs-mcp)", () => {
      const managed = getManagedBundledNpmMcps();
      const pkgs = managed.map((d) => d.npmPackage);
      expect(pkgs).not.toContain("@kevinwatt/yt-dlp-mcp");
      // No tier-2 npm-packaged MCPs should ever appear
      for (const def of managed) {
        expect(def.installFlow ?? "tier-1").toBe("tier-1");
      }
    });
  });

  it("skips core and http defs", async () => {
    let probeCount = 0;
    await runCategoryA({
      ensureBundledNpm: async () => {},
      installBinaryDeps: async () => {},
      probeMcp: async () => { probeCount++; return { status: "up", error: null, durationMs: 0 }; },
      defs: () => [
        { ...fakeDef, id: "libi", core: true },
        { ...fakeDef, id: "fal", type: "http" },
      ],
      ensureNodeRuntime: okNodeRuntime,
      ensureClaudeAdapter: okClaudeAdapter,
    });
    expect(probeCount).toBe(0);
  });

  describe("Node runtime phase (non-fatal)", () => {
    it("emits install-start/-progress/-done through lifecycleEvents on success", async () => {
      await runCategoryA({
        ensureBundledNpm: async () => {},
        installBinaryDeps: async () => {},
        probeMcp: async () => ({ status: "up", error: null, durationMs: 0 }),
        defs: () => [],
        ensureNodeRuntime: async (onProgress) => {
          onProgress?.({ phase: "downloading", bytesDownloaded: 10, bytesTotal: 100 });
          onProgress?.({ phase: "extracting" });
          return { ok: true, path: "/fake/bin/node", source: "downloaded" };
        },
        ensureClaudeAdapter: okClaudeAdapter,
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
        ensureBundledNpm: async () => {},
        installBinaryDeps: async () => {},
        probeMcp: async () => ({ status: "up", error: null, durationMs: 0 }),
        defs: () => [],
        ensureNodeRuntime: okNodeRuntime, // source: "already-managed"
        ensureClaudeAdapter: okClaudeAdapter,
      });
      const done = events.find(
        (e) => e.kind === "category-a-install-done" && e.item.id === "node-runtime",
      );
      expect(done).toMatchObject({ result: "skipped" });
    });

    it("does NOT throw and does NOT abort Category A when ensureNodeRuntime resolves { ok: false }", async () => {
      const calls: string[] = [];
      await expect(
        runCategoryA({
          ensureBundledNpm: async () => { calls.push("npm"); },
          installBinaryDeps: async () => { calls.push("binary"); },
          probeMcp: async () => { calls.push("probe"); return { status: "up", error: null, durationMs: 0 }; },
          defs: () => [fakeDef],
          ensureNodeRuntime: async () => ({ ok: false, error: "no pinned build for this platform" }),
          ensureClaudeAdapter: async () => { calls.push("claude-adapter"); return okClaudeAdapter(); },
        }),
      ).resolves.toBeUndefined();

      // The adapter + probe phases (which run AFTER this one) still ran —
      // proof the { ok: false } outcome didn't abort the sequence.
      expect(calls).toEqual(["npm", "binary", "claude-adapter", "probe"]);

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
          ensureBundledNpm: async () => { calls.push("npm"); },
          installBinaryDeps: async () => { calls.push("binary"); },
          probeMcp: async () => { calls.push("probe"); return { status: "up", error: null, durationMs: 0 }; },
          defs: () => [fakeDef],
          ensureNodeRuntime: async () => { throw new Error("unexpected throw"); },
          ensureClaudeAdapter: async () => { calls.push("claude-adapter"); return okClaudeAdapter(); },
        }),
      ).resolves.toBeUndefined();

      expect(calls).toEqual(["npm", "binary", "claude-adapter", "probe"]);
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
          ensureBundledNpm: async () => { calls.push("npm"); },
          installBinaryDeps: async () => { calls.push("binary"); },
          probeMcp: async () => { calls.push("probe"); return { status: "up", error: null, durationMs: 0 }; },
          defs: () => [fakeDef],
          // Simulates a fetch() that never settles (e.g. a captive portal
          // swallowing the connection) — the phase's own withTimeout wrapper
          // must be what unblocks runCategoryA, not this promise resolving.
          ensureNodeRuntime: () => new Promise<never>(() => {}),
          ensureClaudeAdapter: async () => { calls.push("claude-adapter"); return okClaudeAdapter(); },
        });

        await vi.advanceTimersByTimeAsync(NODE_RUNTIME_PHASE_TIMEOUT_MS + 1_000);
        await run;

        // The rest of Category A still ran — the hang was bounded, not fatal.
        expect(calls).toEqual(["npm", "binary", "claude-adapter", "probe"]);
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
      ).toBe("downloading Node.js runtime — 1.0MB");
      expect(
        nodeRuntimeProgressDetail({
          phase: "downloading",
          bytesDownloaded: 5 * 1024 * 1024,
          bytesTotal: 10 * 1024 * 1024,
        }),
      ).toBe("downloading Node.js runtime — 5.0MB / 10.0MB");
    });
  });
});
