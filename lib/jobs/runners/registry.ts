import type { JobRunner } from "@/lib/jobs/types";
import type { McpToolId } from "@/lib/agents/mcp-tool-id";
import { trackingRunner } from "@/lib/jobs/runners/tracking";
import { trackingProviderRunner } from "@/lib/jobs/runners/tracking-provider";
import { proxyGenRunner } from "@/lib/jobs/runners/proxy-gen";
import { filmstripGenRunner } from "@/lib/jobs/runners/filmstrip-gen";
import { exportRenderRunner } from "@/lib/jobs/runners/export-render";
import { exportRunner } from "@/lib/jobs/runners/export";
import { analysisDescribeFrameRunner } from "@/lib/jobs/runners/analysis-describe-frame";
import { whisperModelDownloadRunner } from "@/lib/jobs/runners/whisper-model-download";
import { ttsModelDownloadRunner } from "@/lib/jobs/runners/tts-model-download";
import { musicModelDownloadRunner } from "@/lib/jobs/runners/music-model-download";
import { musicGenerateRunner } from "@/lib/jobs/runners/music-generate";
import { pieceDupRunner } from "@/lib/jobs/runners/piece-dup";
import { extraAnalysisModelRunner } from "@/lib/jobs/runners/extra-analysis-model";
import { remoteFetchRunner } from "@/lib/jobs/runners/remote-fetch";
import { matteGenRunner } from "@/lib/jobs/runners/matte-gen";
import { runtimeUpdateRunner } from "@/lib/jobs/runners/runtime-update";
import { trackingEngineInstallRunner } from "@/lib/jobs/runners/tracking-engine-install";
import { agentInstallRunner } from "@/lib/jobs/runners/agent-install";
import { devSlowRunner } from "@/lib/jobs/runners/dev-slow";
import { onboardingPieceRunner } from "@/lib/jobs/runners/onboarding-piece";

/**
 * Process-local runner registry. Populated lazily on first
 * `getJobManager()` call inside the Next.js process — see
 * `lib/jobs/manager.ts:getJobManager`.
 *
 * The lifecycle prelude (`lib/cli/studio.ts → runStartupPrelude`) runs in
 * the CLI process, NOT in the Next.js child that JobManager lives in, so
 * eager registration from there never reached the right process. Lazy
 * registration at JobManager-init time fixes that — and is idempotent.
 *
 * The MCP stdio child (`mcp/index.ts`) does NOT populate or use this
 * registry. MCP-side tools that need to invoke a job use the HTTP client
 * in `mcp/jobs-client.ts`, which talks to the Next.js server's
 * `POST /api/jobs` endpoint — keeping runner code (Playwright, ffmpeg,
 * etc.) out of the MCP process.
 */
declare global {
  // eslint-disable-next-line no-var
  var __libiRunnerRegistry: Map<string, JobRunner<unknown, unknown>> | undefined;
}

const runners: Map<string, JobRunner<unknown, unknown>> =
  globalThis.__libiRunnerRegistry ?? new Map();
globalThis.__libiRunnerRegistry = runners;

export function registerRunner<P, R>(runner: JobRunner<P, R>): void {
  if (runners.has(runner.kind)) {
    throw new Error(`Runner already registered for kind: ${runner.kind}`);
  }
  runners.set(runner.kind, runner as JobRunner<unknown, unknown>);
}

export function getRunner(kind: string): JobRunner<unknown, unknown> | null {
  return runners.get(kind) ?? null;
}

export function listRunners(): JobRunner<unknown, unknown>[] {
  return Array.from(runners.values());
}

export function __resetRunnerRegistryForTests(): void {
  runners.clear();
}

/** Register all built-in runners. Synchronous and idempotent: skips kinds
 *  that are already registered.
 *
 *  Called lazily by `getJobManager()` in the Next.js process on first
 *  access. Do not call from MCP-child code — the MCP stdio process
 *  intentionally has no runners; it dispatches via HTTP through
 *  `mcp/jobs-client.ts`. */
export function registerBuiltinRunners(): void {
  for (const r of [
    trackingRunner,
    trackingProviderRunner,
    proxyGenRunner,
    filmstripGenRunner,
    exportRenderRunner,
    exportRunner,
    analysisDescribeFrameRunner,
    whisperModelDownloadRunner,
    ttsModelDownloadRunner,
    musicModelDownloadRunner,
    musicGenerateRunner,
    pieceDupRunner,
    extraAnalysisModelRunner,
    remoteFetchRunner,
    matteGenRunner,
    runtimeUpdateRunner,
    trackingEngineInstallRunner,
    agentInstallRunner,
    onboardingPieceRunner,
    devSlowRunner,
  ]) {
    if (!getRunner(r.kind)) {
      registerRunner(r as JobRunner<unknown, unknown>);
    }
  }
}

/** Build the kind → toolId[] map from registered runners. Called by
 *  `SessionEventHandler.attachJobProgressBridge` at attach time.
 *  Runners without `mcpToolId` (server-internal jobs like proxy_gen) are
 *  intentionally excluded — they have no chat UI surface.
 *
 *  Always returns array form regardless of whether the runner declares a
 *  single ID or an array. This keeps the consumer simple — no Array.isArray
 *  check needed at the lookup site. */
export function getJobKindToToolIdsMap(): Map<string, McpToolId[]> {
  registerBuiltinRunners(); // idempotent
  const out = new Map<string, McpToolId[]>();
  for (const r of listRunners()) {
    if (!r.mcpToolId) continue;
    const ids = Array.isArray(r.mcpToolId) ? r.mcpToolId : [r.mcpToolId];
    out.set(r.kind, ids);
  }
  return out;
}
