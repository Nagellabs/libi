/** In-memory set of virtual-dep ids whose install() is currently
 *  running. The retry-dep route marks before invoking install() and
 *  clears in a finally block; each VirtualDep.inspect() checks this
 *  set so a mid-flight install surfaces as runtimeStatus: "installing"
 *  in the Settings chip.
 *
 *  Scope: Next.js process memory. Survives across requests within the
 *  same server process but resets on restart — acceptable because the
 *  underlying installer (uv subprocess or JobManager) is the source of
 *  truth on restart, and the chip's 2s poll will reconverge.
 *
 *  Shared by EVERY copy of this module in the process: a production Next build loads the
 *  retry-dep route and each `VirtualDep.inspect()` caller apart, and a mark one copy made
 *  was invisible to the other. (d2f3ea41's class.) */
const IN_FLIGHT = ((globalThis as Record<symbol, unknown>)[Symbol.for("libi.virtualDeps.inFlight")] ??=
  new Set<string>()) as Set<string>;

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
