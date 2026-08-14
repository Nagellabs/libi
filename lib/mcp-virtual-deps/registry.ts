import type { VirtualDep } from "./types";
import { localMusicVirtualDeps } from "./local-music";
import { whisperVirtualDeps } from "./whisper";
import { localTtsVirtualDeps } from "./local-tts";

const REG: Map<string, VirtualDep[]> = new Map();

export function registerVirtualDeps(mcpId: string, deps: VirtualDep[]): void {
  const seen = new Set<string>();
  for (const d of deps) {
    if (seen.has(d.id)) throw new Error(`duplicate virtual-dep id "${d.id}" for mcp "${mcpId}"`);
    seen.add(d.id);
  }
  REG.set(mcpId, deps);
}

export function getVirtualDepsForMcp(mcpId: string): VirtualDep[] {
  return REG.get(mcpId) ?? [];
}

/** Exposed for tests only. */
export function _resetForTests(): void {
  REG.clear();
  bootstrapped = false;
}

// Built-in virtual-dep bundles. Registered on first `ensureBootstrapped()`
// call (idempotent). Static imports — the lazy-require pattern broke under
// vitest's TS module resolution and the cost saving was negligible (these
// bundles are tiny pure-data modules with no side effects on import).
let bootstrapped = false;
export function ensureBootstrapped(): void {
  if (bootstrapped) return;
  bootstrapped = true;
  registerVirtualDeps("local-music", localMusicVirtualDeps);
  registerVirtualDeps("whisper", whisperVirtualDeps);
  registerVirtualDeps("local-tts", localTtsVirtualDeps);
}
