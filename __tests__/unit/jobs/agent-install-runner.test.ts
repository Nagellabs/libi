/**
 * Drives `agentInstallRunner.run()` end to end against INJECTED deps — this
 * test must never spawn a real `npm install` (the real one is a ~250 MB,
 * multi-minute download of the Claude ACP adapter).
 *
 * `ensureClaudeAdapterInstalled` and `refreshAgentCache` are supplied via the
 * `runAgentInstall(ctx, deps)` seam rather than `vi.mock`, so production
 * wiring (`agentInstallRunner.run`) is never touched by test doubles — see
 * `lib/tracking/recompute-segment.ts`'s `RecomputeDeps` for the repo's
 * existing shape of this pattern.
 */
import { describe, it, expect, vi } from "vitest";
import { getAgentInstallRoot, type EnsureAdapterResult } from "@/lib/agents/runtime-install";
import type { JobContext } from "@/lib/jobs/types";
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
    claudeNativeBinaryPresent: vi.fn(() => false),
    claudeAdapterVersionCurrent: vi.fn(() => false),
    ensureClaudeAdapterInstalled: vi.fn(async () => ensureResult),
    refreshAgentCache: vi.fn(() => []),
    trackServerEvent: vi.fn(),
  };
}

describe("agentInstallRunner", () => {
  it("refuses an agent that declares no install", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ agentId: "codex" });
    await expect(runAgentInstall(ctx, deps)).rejects.toThrow(/no install step/i);
    expect(deps.ensureClaudeAdapterInstalled).not.toHaveBeenCalled();
  });

  it("refuses an unknown agent id", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ agentId: "not-a-real-agent" });
    await expect(runAgentInstall(ctx, deps)).rejects.toThrow(/no install step/i);
    expect(deps.ensureClaudeAdapterInstalled).not.toHaveBeenCalled();
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
    // The field is rendered by the UI. Reporting a fresh 250 MB install when
    // nothing happened is a lie the user can see.
    const deps = makeDeps();
    deps.resolveInstalledAdapterBin = vi.fn(() => "/existing/path/claude-agent-acp");
    deps.claudeNativeBinaryPresent = vi.fn(() => true);
    deps.claudeAdapterVersionCurrent = vi.fn(() => true);
    const ctx = makeCtx({ agentId: "claude-code" });
    const result = await runAgentInstall(ctx, deps);
    expect(result).toEqual({
      alreadyInstalled: true,
      binPath: "/existing/path/claude-agent-acp",
    });
    expect(deps.ensureClaudeAdapterInstalled).not.toHaveBeenCalled();
    expect(deps.refreshAgentCache).not.toHaveBeenCalled();
    // Asked about the root the installer itself writes. Stubs ignore their
    // arguments, so without this the pre-check could interrogate any path at
    // all — including one that has nothing to do with the adapter — and every
    // test here would still pass.
    expect(deps.claudeAdapterVersionCurrent).toHaveBeenCalledWith(getAgentInstallRoot());
    expect(deps.claudeNativeBinaryPresent).toHaveBeenCalledWith(getAgentInstallRoot());
    // The already-installed fast path re-verified the same two primitives a
    // real installer verifies, so it still counts as "completed".
    expect(deps.trackServerEvent).toHaveBeenCalledWith("agent_install_completed", {
      agent: "claude-code",
    });
  });

  it("runs the installer when the tree is complete but drifted from the pin", async () => {
    // Completeness is not currency. A healthy tree at YESTERDAY'S pin would
    // otherwise report `alreadyInstalled` AND emit `agent_install_completed`
    // without the upgrade the pin bump shipped ever running.
    const ctx = makeCtx({ agentId: "claude-code" });
    const deps = makeDeps();
    deps.resolveInstalledAdapterBin = vi.fn(() => "/existing/path/claude-agent-acp");
    deps.claudeNativeBinaryPresent = vi.fn(() => true);
    deps.claudeAdapterVersionCurrent = vi.fn(() => false);

    const result = await runAgentInstall(ctx, deps);
    expect(deps.ensureClaudeAdapterInstalled).toHaveBeenCalledTimes(1);
    expect(deps.claudeAdapterVersionCurrent).toHaveBeenCalledWith(getAgentInstallRoot());
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
    deps.claudeNativeBinaryPresent = vi.fn(() => true);
    deps.claudeAdapterVersionCurrent = vi.fn(() => false);
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

  it("still runs the installer when the binary is missing even though the bin exists", async () => {
    // The partial-install trap: npm exits 0 on a failed optionalDependency, so
    // a present adapter bin with an absent native binary is NOT installed.
    const deps = makeDeps();
    deps.resolveInstalledAdapterBin = vi.fn(() => "/existing/path/claude-agent-acp");
    deps.claudeNativeBinaryPresent = vi.fn(() => false);
    const ctx = makeCtx({ agentId: "claude-code" });
    const result = await runAgentInstall(ctx, deps);
    expect(deps.ensureClaudeAdapterInstalled).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ alreadyInstalled: false, binPath: "/fake/path/claude-agent-acp" });
  });

  it("rejects when cancelled after the installer resolves, instead of reporting success", async () => {
    const deps = makeDeps();
    let installerResolved = false;
    deps.ensureClaudeAdapterInstalled = vi.fn(async () => {
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
    // codex/unknown ids are rejected before the try/verify path this file's
    // emit points live in — nothing to report either way.
    const deps = makeDeps();
    const ctx = makeCtx({ agentId: "codex" });
    await expect(runAgentInstall(ctx, deps)).rejects.toThrow(/no install step/i);
    expect(deps.trackServerEvent).not.toHaveBeenCalled();
  });

  it("is exclusiveResource, so a retry cannot race a running install", () => {
    expect(agentInstallRunner.exclusiveResource).toBe(true);
  });

  it("has no progress watchdog — a cold 250 MB install is legitimately silent", () => {
    expect(agentInstallRunner.noProgressTimeoutMs).toBeNull();
  });

  it("registers under kind=\"agent_install\" with no mcpToolId — user-initiated only", () => {
    expect(agentInstallRunner.kind).toBe("agent_install");
    expect(agentInstallRunner.mcpToolId).toBeUndefined();
  });
});

/**
 * Finding 4: the guard has to be as narrow as the runner actually is.
 *
 * `setup.install !== null` reads like "this agent declares an install", but
 * everything past it — `resolveInstalledAdapterBin`, `claudeNativeBinaryPresent`,
 * `ensureClaudeAdapterInstalled` — installs CLAUDE CODE's adapter and nothing
 * else. A third agent added to `AGENT_SETUPS` with an install declaration is
 * offered an Install button by the onboarding panel, accepted by the route,
 * waved through this guard, and then handed Claude Code's install while being
 * told its own succeeded. That is the branch's own "a third agent would
 * silently be treated as Codex" bug, one layer down.
 */
describe("agentInstallRunner — only Claude Code is actually installable", () => {
  it("refuses an agent that declares an install this runner cannot perform", async () => {
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
      await expect(run(ctx, deps)).rejects.toThrow(/claude-code/i);
      // Nothing Claude-specific may run for another agent's id.
      expect(deps.ensureClaudeAdapterInstalled).not.toHaveBeenCalled();
      expect(deps.resolveInstalledAdapterBin).not.toHaveBeenCalled();
      expect(deps.trackServerEvent).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock("@/lib/agents/setup/registry");
      vi.resetModules();
    }
  });

  it("still installs claude-code, the one agent it knows how to install", async () => {
    const deps = makeDeps();
    const ctx = makeCtx({ agentId: "claude-code" });
    await expect(runAgentInstall(ctx, deps)).resolves.toMatchObject({ alreadyInstalled: false });
  });
});
