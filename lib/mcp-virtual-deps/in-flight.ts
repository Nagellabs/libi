/** In-memory set of virtual-dep ids whose install() is currently
 *  running. The retry-dep route marks before invoking install() and
 *  clears in a finally block; each VirtualDep.inspect() checks this
 *  set so a mid-flight install surfaces as runtimeStatus: "installing"
 *  in the Settings chip.
 *
 *  Scope: Next.js process memory. Survives across requests within the
 *  same server process but resets on restart — acceptable because the
 *  underlying installer (uv subprocess or JobManager) is the source of
 *  truth on restart, and the chip's 2s poll will reconverge. */

const IN_FLIGHT = new Set<string>();

export function markInstalling(id: string): void {
  IN_FLIGHT.add(id);
}

export function clearInstalling(id: string): void {
  IN_FLIGHT.delete(id);
}

export function isInstalling(id: string): boolean {
  return IN_FLIGHT.has(id);
}

/** Exposed for tests only. */
export function _resetInFlight(): void {
  IN_FLIGHT.clear();
}
