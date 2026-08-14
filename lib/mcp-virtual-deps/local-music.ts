import type { VirtualDep } from "./types";
import { aceStepModelVirtualDep } from "./ace-step-model-dep";
import { aceStepEnvVirtualDep } from "./ace-step-env-dep";
import { musicAnalysisEnvVirtualDep } from "./music-analysis-env-dep";

/** Virtual-dep bundle for the `local-music` MCP. Registered with the
 *  registry via `ensureBootstrapped()` in `./registry.ts`.
 *
 *  NOTE: `./music-analysis-env-dep` lands in Task 12. This import will
 *  fail at module load until then — but `ensureBootstrapped()` requires
 *  this file lazily, and nothing currently calls it, so this commit is
 *  safe in isolation. */
export const localMusicVirtualDeps: VirtualDep[] = [
  aceStepModelVirtualDep,
  aceStepEnvVirtualDep,
  musicAnalysisEnvVirtualDep,
];
