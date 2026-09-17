/**
 * Drives `agentInstallRunner.run()` end to end against INJECTED deps — this
 * test must never spawn a real `npm install` of an ACP adapter (tens of MB,
 * and minutes on a slow line).
 *
 * `ensureAdapterInstalled` and `refreshAgentCache` are supplied via the
 * `runAgentInstall(ctx, deps)` seam rather than `vi.mock`, so production
 * wiring (`agentInstallRunner.run`) is never touched by test doubles — see
 * `lib/tracking/recompute-segment.ts`'s `RecomputeDeps` for the repo's
 * existing shape of this pattern.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getAgentInstallRoot, type EnsureAdapterResult } from "@/lib/agents/runtime-install";
import { CLAUDE_ADAPTER_PACKAGE, CODEX_ADAPTER_PACKAGE } from "@/lib/agents/runtime-packages";
import type { JobContext } from "@/lib/jobs/types";

// The runner drops the agent's CLI memo when an install completes. Mocked so
// the tests can see that call without resolving a real CLI.
const { mockInvalidateAgentCliMemo } = vi.hoisted(() => ({
  mockInvalidateAgentCliMemo: vi.fn<(agentId?: string) => void>(),
}));
vi.mock("@/lib/agents/cli/resolve", () => ({
  invalidateAgentCliMemo: (agentId?: string) => mockInvalidateAgentCliMemo(agentId),
}));
import {
  agentInstallRunner,
  runAgentInstall,
  type AgentInstallParams,
} from "@/lib/jobs/runners/agent-install";

function makeCtx(
  params: AgentInstallParams,
  overrides: Partial<JobContext<AgentInstallParams>> = {},
): JobContext<AgentInstallParams> {
  return {
    jobId: "job-agent-install",
    params,
    resumeState: null,
    reportProgress: vi.fn(),
    checkpoint: vi.fn(async () => {}),
    shouldCancel: vi.fn(() => false),
    forced: false,
    ...overrides,
  };
}

function makeDeps(overrides: {
  ensureResult?: EnsureAdapterResult;
} = {}) {
  const ensureResult: EnsureAdapterResult = overrides.ensureResult ?? {
    installed: true,
    binPath: "/fake/path/claude-agent-acp",
  };
  return {
    // Defaults model "nothing installed yet" so every existing test still
    // exercises the full installer path unless a test overrides these.
    resolveInstalledAdapterBin: vi.fn(() => null as string | null),
    adapterVersionCurrent: vi.fn(() => false),
    // Announces its install start the way the real installer does — from
    // inside the cross-process lock, once it has decided `npm install` really
    // is going to run. That is where the runner takes its progress baseline
    // so a fake that stayed silent would mean no bar at all.
    ensureAdapterInstalled: vi.fn(
      async (_agentId: string, opts?: { onInstallStart?: () => void }) => {
        opts?.onInstallStart?.();
        return ensureResult;
      },
    ),
    refreshAgentCache: vi.fn(() => []),
    trackServerEvent: vi.fn(),
  };
}

/** The bar's MB totals, derived from the packages the way the runner derives them. */
const CLAUDE_TOTAL_MB = Math.floor(CLAUDE_ADAPTER_PACKAGE.estimatedInstallBytes / 1_000_000);
const CODEX_TOTAL_MB = Math.floor(CODEX_ADAPTER_PACKAGE.estimatedInstallBytes / 1_000_000);

beforeEach(() => {
  mockInvalidateAgentCliMemo.mockReset();
});

describe("agentInstallRunner", () => {
  it("refuses an agent that declares no install", async () => {
    // Terminal is a pseudo-provider with no setup declaration at all — the
    // registry returns null for it, so there is nothing to install.
    const deps = makeDeps();
    const ctx = makeCtx({ agentId: "terminal" });
    await expect(runAgentInstall(ctx, deps)).rejects.toThrow(/no install step/i);
    expect(deps.ensureAdapterInstalled).not.toHaveBeenCalled();
  });

  it("refuses an unknown agent id", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ agentId: "not-a-real-agent" });
    await expect(runAgentInstall(ctx, deps)).rejects.toThrow(/no install step/i);
    expect(deps.ensureAdapterInstalled).not.toHaveBeenCalled();
  });

  it("reports MB, because that is what the UI renders verbatim", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ agentId: "claude-code" });
    await runAgentInstall(ctx, deps);
    const calls = (ctx.reportProgress as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [, , unit] of calls) {
      expect(unit).toBe("MB");
    }
  });

  it("fails when the installer returns installed:false, even without throwing", async () => {
    const deps = makeDeps({
      ensureResult: { installed: false, binPath: null, error: "npm registry blocked" },
    });
    const ctx = makeCtx({ agentId: "claude-code" });
    await expect(runAgentInstall(ctx, deps)).rejects.toThrow(/npm registry blocked/);
    expect(deps.refreshAgentCache).not.toHaveBeenCalled();
    // Bounded reason, not the raw diagnostic — "npm registry blocked" isn't
    // one of npm-root.ts's own strings, so it lands in the "unknown" bucket.
    expect(deps.trackServerEvent).toHaveBeenCalledWith("agent_install_failed", {
      agent: "claude-code",
      reason: "unknown",
    });
    expect(deps.trackServerEvent).not.toHaveBeenCalledWith(
      "agent_install_completed",
      expect.anything(),
    );
  });

  it("refreshes the detection cache on success, so the app sees the new agent", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ agentId: "claude-code" });
    const result = await runAgentInstall(ctx, deps);
    expect(deps.refreshAgentCache).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ alreadyInstalled: false, binPath: "/fake/path/claude-agent-acp" });
    expect(deps.trackServerEvent).toHaveBeenCalledWith("agent_install_completed", {
      agent: "claude-code",
    });
  });

  it("returns alreadyInstalled without running the installer when the adapter is already there", async () => {
    // The field is rendered by the UI. Reporting a fresh install when
    // nothing happened is a lie the user can see.
    const deps = makeDeps();
    deps.resolveInstalledAdapterBin = vi.fn(() => "/existing/path/claude-agent-acp");
    deps.adapterVersionCurrent = vi.fn(() => true);
    const ctx = makeCtx({ agentId: "claude-code" });
    const result = await runAgentInstall(ctx, deps);
    expect(result).toEqual({
      alreadyInstalled: true,
      binPath: "/existing/path/claude-agent-acp",
    });
    expect(deps.ensureAdapterInstalled).not.toHaveBeenCalled();
    // The tree may predate this process's detection cache (another libi sharing
    // the root installed it). Unrefreshed, the status keeps reading "missing"
    // and a Retry would only land back here.
    expect(deps.refreshAgentCache).toHaveBeenCalledTimes(1);
    // Asked about the root the installer itself writes, AND about the package
    // this job is for. Stubs ignore their arguments, so without this the
    // pre-check could interrogate any path at all — or Claude's tree on a
    // Codex job — and every test here would still pass.
    expect(deps.resolveInstalledAdapterBin).toHaveBeenCalledWith(CLAUDE_ADAPTER_PACKAGE);
    expect(deps.adapterVersionCurrent).toHaveBeenCalledWith(getAgentInstallRoot(), CLAUDE_ADAPTER_PACKAGE);
    // The already-installed fast path re-verified the same primitives a real
    // installer verifies, so it still counts as "completed".
    expect(deps.trackServerEvent).toHaveBeenCalledWith("agent_install_completed", {
      agent: "claude-code",
    });
  });

  it("runs the installer when the adapter is present but drifted from the pin", async () => {
    // A present bin is not a current one. A healthy tree at YESTERDAY'S pin would
    // otherwise report `alreadyInstalled` AND emit `agent_install_completed`
    // without the upgrade the pin bump shipped ever running.
    const ctx = makeCtx({ agentId: "claude-code" });
    const deps = makeDeps();
    deps.resolveInstalledAdapterBin = vi.fn(() => "/existing/path/claude-agent-acp");
    deps.adapterVersionCurrent = vi.fn(() => false);

    const result = await runAgentInstall(ctx, deps);
    expect(deps.ensureAdapterInstalled).toHaveBeenCalledTimes(1);
    expect(deps.ensureAdapterInstalled).toHaveBeenCalledWith("claude-code", expect.anything());
    expect(deps.adapterVersionCurrent).toHaveBeenCalledWith(getAgentInstallRoot(), CLAUDE_ADAPTER_PACKAGE);
    expect(result).toEqual({ alreadyInstalled: false, binPath: "/fake/path/claude-agent-acp" });
  });

  it("does NOT report a completed install when the upgrade failed and the old tree was kept", async () => {
    // The rollout-blindness case: a drifted tree falls through the pre-check,
    // a full progress-tracked npm runs, that npm FAILS, and the installer
    // hands back the working OLD adapter — `installed: true`, because taking
    // Claude Code away over a failed download would leave the user worse off
    // than before the release. Routing that back down the success path emits
    // `agent_install_completed`, i.e. the funnel reports a clean upgrade for
    // precisely the users the upgrade never reached. `upgradeError` is what
    // keeps the two apart.
    const deps = makeDeps({
      ensureResult: {
        installed: true,
        binPath: "/existing/path/claude-agent-acp",
        staleVersion: "0.44.0",
        upgradeError: "npm ERR! code ENOTFOUND registry.npmjs.org",
      },
    });
    deps.resolveInstalledAdapterBin = vi.fn(() => "/existing/path/claude-agent-acp");
    deps.adapterVersionCurrent = vi.fn(() => false);
    const ctx = makeCtx({ agentId: "claude-code" });

    const result = await runAgentInstall(ctx, deps);

    // Does not throw, and still hands back a usable bin — Claude Code stays
    // selectable on the version the user already had.
    expect(result).toEqual({
      alreadyInstalled: false,
      binPath: "/existing/path/claude-agent-acp",
    });
    expect(deps.trackServerEvent).not.toHaveBeenCalledWith(
      "agent_install_completed",
      expect.anything(),
    );
    // Bounded reason, mapped from the raw npm diagnostic — never the raw
    // string, which routinely carries paths.
    expect(deps.trackServerEvent).toHaveBeenCalledWith("agent_install_failed", {
      agent: "claude-code",
      reason: "npm_failed",
    });
    // The two things the branch does BESIDES reporting, both previously
    // deletable with the suite green. Without `refreshAgentCache` the
    // agent-registry detection cache keeps serving "not installed" until a
    // restart — the exact dead end this job exists to remove — and without the
    // final `reportProgress` the bar stops wherever npm died, so a user who
    // ends up with a perfectly usable (if old) adapter watches a stalled
    // progress bar. Asserted as a property, not against the byte constant,
    // so re-measuring the download size doesn't falsely fail this test.
    expect(deps.refreshAgentCache).toHaveBeenCalledTimes(1);
    const lastProgress = vi.mocked(ctx.reportProgress).mock.calls.at(-1);
    expect(lastProgress?.[0]).toBe(lastProgress?.[1]);
    expect(lastProgress?.[2]).toBe("MB");
  });

  it("rejects when cancelled after the installer resolves, instead of reporting success", async () => {
    const deps = makeDeps();
    let installerResolved = false;
    deps.ensureAdapterInstalled = vi.fn(async () => {
      installerResolved = true;
      return { installed: true, binPath: "/fake/path/claude-agent-acp" };
    });
    const ctx = makeCtx(
      { agentId: "claude-code" },
      { shouldCancel: vi.fn(() => installerResolved) },
    );
    await expect(runAgentInstall(ctx, deps)).rejects.toThrow(/cancelled/);
    expect(deps.refreshAgentCache).not.toHaveBeenCalled();
    expect(deps.trackServerEvent).toHaveBeenCalledWith("agent_install_failed", {
      agent: "claude-code",
      reason: "cancelled",
    });
  });

  it("refuses an agent that declares no install without ever emitting an install event", async () => {
    // terminal/unknown ids are rejected before the try/verify path this
    // file's emit points live in — nothing to report either way.
    const deps = makeDeps();
    const ctx = makeCtx({ agentId: "terminal" });
    await expect(runAgentInstall(ctx, deps)).rejects.toThrow(/no install step/i);
    expect(deps.trackServerEvent).not.toHaveBeenCalled();
  });

  it("drops the agent's CLI memo when an install completes, so the next status poll resolves afresh", async () => {
    const deps = makeDeps({ ensureResult: { installed: true, binPath: "/fake/path/codex-acp" } });
    await runAgentInstall(makeCtx({ agentId: "codex" }), deps);
    expect(mockInvalidateAgentCliMemo).toHaveBeenCalledTimes(1);
    expect(mockInvalidateAgentCliMemo).toHaveBeenCalledWith("codex");
  });

  it("leaves the CLI memo alone when the install is cancelled or fails", async () => {
    const cancelled = makeDeps();
    await expect(
      runAgentInstall(makeCtx({ agentId: "claude-code" }, { shouldCancel: vi.fn(() => true) }), cancelled),
    ).rejects.toThrow(/cancelled/);

    const failed = makeDeps({ ensureResult: { installed: false, binPath: null, error: "npm exploded" } });
    await expect(runAgentInstall(makeCtx({ agentId: "claude-code" }), failed)).rejects.toThrow(/npm exploded/);

    expect(mockInvalidateAgentCliMemo).not.toHaveBeenCalled();
  });

  it("never fails a completed install because the CLI memo could not be dropped", async () => {
    mockInvalidateAgentCliMemo.mockImplementation(() => {
      throw new Error("memo exploded");
    });
    const deps = makeDeps();
    const ctx = makeCtx({ agentId: "claude-code" });
    await expect(runAgentInstall(ctx, deps)).resolves.toEqual({
      alreadyInstalled: false,
      binPath: "/fake/path/claude-agent-acp",
    });
    expect(mockInvalidateAgentCliMemo).toHaveBeenCalledWith("claude-code");
    expect(deps.refreshAgentCache).toHaveBeenCalledTimes(1);
    expect(deps.trackServerEvent).toHaveBeenCalledWith("agent_install_completed", { agent: "claude-code" });
  });

  it("is exclusiveResource, so a retry cannot race a running install", () => {
    expect(agentInstallRunner.exclusiveResource).toBe(true);
  });

  it("has no progress watchdog — a cold multi-hundred-MB install is legitimately silent", () => {
    expect(agentInstallRunner.noProgressTimeoutMs).toBeNull();
  });

  it("registers under kind=\"agent_install\" with no mcpToolId — user-initiated only", () => {
    expect(agentInstallRunner.kind).toBe("agent_install");
    expect(agentInstallRunner.mcpToolId).toBeUndefined();
  });
});

/**
 * Codex downloads on selection exactly like Claude
 * Code, through this same runner — there is no second installer.
 */
describe("codex", () => {
  it("installs the Codex adapter rather than rejecting it", async () => {
    const deps = makeDeps({
      ensureResult: { installed: true, binPath: "/fake/path/codex-acp" },
    });
    const ctx = makeCtx({ agentId: "codex" });
    const result = await runAgentInstall(ctx, deps);
    expect(deps.ensureAdapterInstalled).toHaveBeenCalledWith("codex", expect.anything());
    expect(result.binPath).not.toBeNull();
    // The pre-check is asked about CODEX'S package — a Codex job that
    // interrogated Claude's tree would report Claude's state as Codex's.
    expect(deps.resolveInstalledAdapterBin).toHaveBeenCalledWith(CODEX_ADAPTER_PACKAGE);
    expect(deps.trackServerEvent).toHaveBeenCalledWith("agent_install_completed", { agent: "codex" });
  });

  it("reports an already-installed Codex from Codex's own tree, not Claude's", async () => {
    const deps = makeDeps();
    deps.resolveInstalledAdapterBin = vi.fn(() => "/existing/path/codex-acp");
    deps.adapterVersionCurrent = vi.fn(() => true);
    const result = await runAgentInstall(makeCtx({ agentId: "codex" }), deps);
    expect(result).toEqual({ alreadyInstalled: true, binPath: "/existing/path/codex-acp" });
    expect(deps.ensureAdapterInstalled).not.toHaveBeenCalled();
    expect(deps.adapterVersionCurrent).toHaveBeenCalledWith(getAgentInstallRoot(), CODEX_ADAPTER_PACKAGE);
  });

  it("sizes the progress bar for Codex's own download, not Claude's", async () => {
    // The bar's denominator is what the card renders as "N / 17 MB". Sharing
    // Claude's 56 MB total would pin a finished Codex install at ~30%.
    const deps = makeDeps({
      ensureResult: { installed: true, binPath: "/fake/path/codex-acp" },
    });
    const ctx = makeCtx({ agentId: "codex" });
    await runAgentInstall(ctx, deps);
    const [firstDone, firstTotal, unit] = vi.mocked(ctx.reportProgress).mock.calls[0]!;
    expect([firstDone, firstTotal, unit]).toEqual([0, CODEX_TOTAL_MB, "MB"]);
    expect(CODEX_TOTAL_MB).not.toBe(CLAUDE_TOTAL_MB);
  });

  it("rejects an agent with no declared install", async () => {
    const deps = makeDeps();
    await expect(
      runAgentInstall(makeCtx({ agentId: "terminal" }), deps),
    ).rejects.toThrow("terminal has no install step");
  });
});

/**
 * Both adapters install into ONE root (`~/.libi/agents`),
 * and the progress bar watched that whole root. With Claude's tree already
 * installed, picking Codex measured Claude's bytes on the first tick, clamped
 * to the (smaller) Codex total, and read complete for the entire download.
 * The bar must count only bytes that arrive AFTER the install starts. The
 * fixtures below write far more than either total, so the clamp is exercised.
 */
describe("agentInstallRunner — progress against a shared install root", () => {
  it("starts at 0 MB when another adapter already occupies the root", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-agent-install-"));
    const previousHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = tmp;
    try {
      // Claude's tree, already on disk before the Codex install starts. Sparse:
      // `stat.size` is the apparent size, which is what `directoryBytes` sums.
      const claudeBlob = path.join(
        getAgentInstallRoot(),
        "node_modules/@agentclientprotocol/claude-agent-acp/blob",
      );
      fs.mkdirSync(path.dirname(claudeBlob), { recursive: true });
      fs.writeFileSync(claudeBlob, "");
      fs.truncateSync(claudeBlob, 345_000_000);

      const ctx = makeCtx({ agentId: "codex" });
      const deps = makeDeps({
        ensureResult: { installed: true, binPath: "/fake/path/codex-acp" },
      });
      // Hold the "npm install" open until the tracker's first measurement has
      // been reported, so the assertion sees what a user would see.
      deps.ensureAdapterInstalled = vi.fn(
        async (_agentId: string, opts?: { onInstallStart?: () => void }) => {
          opts?.onInstallStart?.();
          await vi.waitFor(() =>
            expect(vi.mocked(ctx.reportProgress).mock.calls.length).toBeGreaterThanOrEqual(2),
          );
          return { installed: true, binPath: "/fake/path/codex-acp" };
        },
      );

      await runAgentInstall(ctx, deps);

      const calls = vi.mocked(ctx.reportProgress).mock.calls;
      expect(calls[0]).toEqual([0, CODEX_TOTAL_MB, "MB"]);
      // The first MEASURED report: Claude's tree is the baseline, not progress.
      expect(calls[1]).toEqual([0, CODEX_TOTAL_MB, "MB"]);
    } finally {
      if (previousHome === undefined) delete process.env.LIBI_HOME;
      else process.env.LIBI_HOME = previousHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("takes the baseline when the installer announces its start, not before it", { timeout: 15_000 }, async () => {
    // `maxConcurrent: 1` serialises this PROCESS only. A second libi holding
    // the installer's cross-process lock grows the shared root while we wait,
    // and a baseline measured before that wait describes a directory that no
    // longer exists. Simulated here by writing the other process's bytes
    // between the call and `onInstallStart`.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "libi-agent-install-"));
    const previousHome = process.env.LIBI_HOME;
    process.env.LIBI_HOME = tmp;
    try {
      fs.mkdirSync(getAgentInstallRoot(), { recursive: true });

      const ctx = makeCtx({ agentId: "codex" });
      const deps = makeDeps();
      deps.ensureAdapterInstalled = vi.fn(
        async (_agentId: string, opts?: { onInstallStart?: () => void }) => {
          // …waiting on the lock while another process installs 345 MB.
          const otherBlob = path.join(getAgentInstallRoot(), "other-process-blob");
          fs.writeFileSync(otherBlob, "");
          fs.truncateSync(otherBlob, 345_000_000);
          // Only NOW is it our install's turn.
          opts?.onInstallStart?.();
          // Long enough for the tracker's immediate measure AND at least one
          // interval measure (1500 ms) to land, so the assertion below is not
          // reading a single tick that happened to race the write.
          await new Promise((r) => setTimeout(r, 1_800));
          return { installed: true, binPath: "/fake/path/codex-acp" };
        },
      );

      await runAgentInstall(ctx, deps);

      const calls = vi.mocked(ctx.reportProgress).mock.calls;
      // Every tick before the terminal one is 0, not complete: those 345 MB
      // arrived before our install started, so they are baseline. Measured
      // before the lock they would have read as progress and pinned the bar at
      // 100 % from its very first measure.
      expect(calls.length).toBeGreaterThanOrEqual(3);
      for (const call of calls.slice(0, -1)) expect(call).toEqual([0, CODEX_TOTAL_MB, "MB"]);
    } finally {
      if (previousHome === undefined) delete process.env.LIBI_HOME;
      else process.env.LIBI_HOME = previousHome;
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("tracks nothing when the installer never announces a start (it skipped)", async () => {
    // Another process installed while we waited, or the tree was already
    // current: `installAgentPackages` returns before `onInstallStart`. There
    // is no download to draw, and drawing one would be a lie — the terminal
    // tick still completes the bar.
    const ctx = makeCtx({ agentId: "claude-code" });
    const deps = makeDeps();
    deps.ensureAdapterInstalled = vi.fn(async () => ({
      installed: true,
      binPath: "/fake/path/claude-agent-acp",
    }));

    await runAgentInstall(ctx, deps);

    const calls = vi.mocked(ctx.reportProgress).mock.calls;
    expect(calls[0]).toEqual([0, CLAUDE_TOTAL_MB, "MB"]);
    expect(calls.at(-1)).toEqual([CLAUDE_TOTAL_MB, CLAUDE_TOTAL_MB, "MB"]);
  });
});

/**
 * The guard has to be as narrow as the
 * runner actually is.
 *
 * `setup.install !== null` reads like "this agent declares an install", but
 * what the runner can actually install is whatever `runtime-packages.ts`
 * registers a `RuntimeAgentPackage` for. A third agent added to
 * `AGENT_SETUPS` with an install declaration but no package entry is offered
 * an Install button on the Agents page, accepted by the route, and would
 * then have nothing to install — the runner must fail loudly and early rather
 * than run someone else's install under its name.
 */
describe("agentInstallRunner — a declared install needs a registered runtime package", () => {
  it("refuses an agent that declares an install with no RuntimeAgentPackage behind it", async () => {
    const deps = makeDeps();
    // Stands in for a third `AGENT_SETUPS` entry with an `install` block. The
    // registry is pure data, so the honest way to prove the guard is to hand
    // the runner an id the registry knows nothing about while pretending it
    // declares an install — done here by mocking the lookup.
    vi.resetModules();
    vi.doMock("@/lib/agents/setup/registry", () => ({
      getAgentSetup: (id: string) =>
        id === "third-agent"
          ? {
              id: "third-agent",
              name: "Third Agent",
              blurb: "",
              install: { command: "npm i -g third-agent", sizeLabel: "1 MB", manual: [] },
              signIn: { displayCommand: "third", manual: [] },
            }
          : null,
    }));
    try {
      const { runAgentInstall: run } = await import("@/lib/jobs/runners/agent-install");
      const ctx = makeCtx({ agentId: "third-agent" });
      await expect(run(ctx, deps)).rejects.toThrow(/RuntimeAgentPackage/);
      // Nothing may run for an agent the installer has no package for.
      expect(deps.ensureAdapterInstalled).not.toHaveBeenCalled();
      expect(deps.resolveInstalledAdapterBin).not.toHaveBeenCalled();
      expect(deps.trackServerEvent).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("@/lib/agents/setup/registry");
      vi.resetModules();
    }
  });

  it("still installs claude-code end to end", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ agentId: "claude-code" });
    await expect(runAgentInstall(ctx, deps)).resolves.toMatchObject({ alreadyInstalled: false });
  });
});
