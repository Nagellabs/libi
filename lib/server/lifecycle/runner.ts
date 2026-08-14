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
 * CLI entry point. Runs Category A synchronously. On failure emits a
 * `fatal` event with hint and returns `{ ok: false }`. The CLI exits 1.
 * On success returns `{ ok: true }` and the caller spawns Next.js.
 */
export async function runInstallPhase(
  opts: RunInstallPhaseOptions,
): Promise<InstallPhaseResult> {
  const unsubscribe = lifecycleEvents.on((e) => opts.adapter.onEvent(e));
  lifecycleEvents.emit({ kind: "prelude-start" });
  try {
    await runCategoryA(opts.deps ?? defaultCategoryADeps);
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
