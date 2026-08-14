import type { VirtualDep } from "./types";
import { whisperModelVirtualDep } from "./whisper-model-dep";
import { whisperEnvVirtualDep } from "./whisper-env-dep";

/** Whisper MCP virtual deps: default model weights + uv env warm-up. */
export const whisperVirtualDeps: VirtualDep[] = [
  whisperModelVirtualDep,
  whisperEnvVirtualDep,
];
