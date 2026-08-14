import type { VirtualDep } from "./types";
import { ttsModelVirtualDep } from "./tts-model-dep";
import { ttsEnvVirtualDep } from "./tts-env-dep";

export const localTtsVirtualDeps: VirtualDep[] = [
  ttsModelVirtualDep,
  ttsEnvVirtualDep,
];
