import { lifecycleEvents } from "./events";
import {
  defaultCategoryADeps,
  runCategoryA,
  InstallPhaseError,
  type CategoryADeps,
} from "./category-a";
import {
  defaultCategoryBDeps,
  runCategoryB,
  BootPhaseError,
  type CategoryBDeps,
} from "./category-b";
import type {
  InstallPhaseResult,
  BootPhaseResult,
  LifecycleAdapter,
  CategoryBStepId,
} from "./types";

export interface RunInstallPhaseOptions {
  adapter: LifecycleAdapter;
  deps?: CategoryADeps;
}

/**
 * After a successful install phase, keep handing the same adapter `warning`
 * events, and only those, for the rest of the process.
 *
 * For `npx` and the packaged desktop app, Category B runs later in this same
 * process, inside Next's `prepare()`, while the terminal or the splash is still
 * what the user is watching. `runBootPhase` there has no adapter of its own
 * (`instrumentation.ts` passes a no-op), so without this a boot that carried on
 * without libi's tools said so only in a log file. Progress events are not
 * forwarded: this changes what the user is told about problems, not what boot
 * output looks like. A dev checkout runs Next in a child process this cannot
 * reach; the in-app surfaces cover that case.
 */
function forwardBootWarnings(adapter: LifecycleAdapter): void {
  lifecycleEvents.on((e) => {
    if (e.kind === "warning") adapter.onEvent(e);
  });
}

/**
 * CLI entry point. Runs Category A synchronously. On failure emits a
 * `fatal` event with hint and returns `{ ok: false }`. The CLI exits 1.
 * On success returns `{ ok: true }` and the caller spawns Next.js; the adapter
 * goes on receiving boot `warning` events (see `forwardBootWarnings`).
 */
export async function runInstallPhase(
  opts: RunInstallPhaseOptions,
): Promise<InstallPhaseResult> {
  const unsubscribe = lifecycleEvents.on((e) => opts.adapter.onEvent(e));
  lifecycleEvents.emit({ kind: "prelude-start" });
  try {
    await runCategoryA(opts.deps ?? defaultCategoryADeps);
    forwardBootWarnings(opts.adapter);
    return { ok: true };
  } catch (err) {
    const phaseErr = err instanceof InstallPhaseError ? err : null;
    const message = phaseErr
      ? phaseErr.message
      : err instanceof Error
        ? err.message
        : String(err);
    const step = phaseErr ? phaseErr.step : null;
    const hint = phaseErr ? phaseErr.hint : "See the error above for details.";
    lifecycleEvents.emit({
      kind: "fatal",
      phase: "category-a",
      step,
      error: message,
      hint,
    });
    return { ok: false, fatal: { phase: "category-a", step, error: message, hint } };
  } finally {
    unsubscribe();
  }
}

export interface RunBootPhaseOptions {
  adapter: LifecycleAdapter;
  deps?: CategoryBDeps;
}

/**
 * Next.js entry point. Runs Category B synchronously. On failure emits
 * `fatal` and returns `{ ok: false }`; the Next.js process keeps running
 * but the UI shows a fatal banner via the same SSE events.
 */
export async function runBootPhase(
  opts: RunBootPhaseOptions,
): Promise<BootPhaseResult> {
  const unsubscribe = lifecycleEvents.on((e) => opts.adapter.onEvent(e));
  try {
    await runCategoryB(opts.deps ?? defaultCategoryBDeps);
    return { ok: true };
  } catch (err) {
    const phaseErr = err instanceof BootPhaseError ? err : null;
    const message = phaseErr
      ? phaseErr.message
      : err instanceof Error
        ? err.message
        : String(err);
    const step: CategoryBStepId | null = phaseErr ? phaseErr.step : null;
    const hint = phaseErr ? phaseErr.hint : "See the error above for details.";
    lifecycleEvents.emit({
      kind: "fatal",
      phase: "category-b",
      step,
      error: message,
      hint,
    });
    return { ok: false, fatal: { phase: "category-b", step, error: message, hint } };
  } finally {
    unsubscribe();
  }
}
