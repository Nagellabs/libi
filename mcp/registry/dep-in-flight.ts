/**
 * `(mcpId, binary)` → when its install was ACCEPTED, for installs that have
 * been accepted but have not yet reached the code that reports itself as
 * installing.
 *
 * Why it exists. `POST /api/settings/mcp-servers/[id]/retry-dep` is
 * fire-and-forget: it answers `{ accepted: true }` and runs `retryDep` in the
 * background. Two things go wrong in the gap that leaves.
 *
 *  1. The dependency chip's own "installing" evidence only appears later —
 *     `ensureChromium` registering its flight, or the first persisted
 *     `writeDepTransition`. Until then the poll still says `pending`, so the
 *     Download button un-disables itself and a second click starts a second
 *     173 MB download. `isDepInstalling` closes that window: the chip shows
 *     the spinner, which renders no button at all.
 *
 *  2. The accepted-at TIMESTAMP is what lets a later force decide whether it
 *     is still asking for anything. `runCustomInstaller` derives `force` from
 *     a fresh `verify()`, so a click made while a download was running becomes
 *     a forced re-download if that download finishes first — 173 MB to replace
 *     the 173 MB that just landed. An install that completed AFTER the click
 *     was accepted has already served it. See `EnsureChromiumOptions.requestedAt`.
 *
 * Scope: Next.js process memory, exactly like `lib/mcp-virtual-deps/in-flight.ts`
 * — this is the binary-dep half of the same pattern. It resets on restart,
 * which is correct: after a restart there IS no install running in this
 * process, and the on-disk state is the truth.
 */

const IN_FLIGHT = new Map<string, number>();

const key = (mcpId: string, binary: string): string => `${mcpId} ${binary}`;

export function markDepInstalling(mcpId: string, binary: string): void {
  IN_FLIGHT.set(key(mcpId, binary), Date.now());
}

export function clearDepInstalling(mcpId: string, binary: string): void {
  IN_FLIGHT.delete(key(mcpId, binary));
}

export function isDepInstalling(mcpId: string, binary: string): boolean {
  return IN_FLIGHT.has(key(mcpId, binary));
}

/** When the outstanding install request for this dep was accepted, or
 *  `undefined` when it did not come through the retry-dep route (Category A,
 *  an export, the tracker — none of which force). */
export function depInstallAcceptedAt(mcpId: string, binary: string): number | undefined {
  return IN_FLIGHT.get(key(mcpId, binary));
}

/** Exposed for tests only. */
export function _resetDepInFlight(): void {
  IN_FLIGHT.clear();
}
