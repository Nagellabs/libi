// lib/server/lifecycle/relaunch.ts
/** Called by /api/server-status/reset. Electron main process registers
 *  a handler at startup; CLI / dev script handlers exit with code 75
 *  so the parent shell can react. */
type Handler = () => void;

// The slot lives on `globalThis`, NOT in a module variable, for two reasons —
// and the second one is why a module variable could never have worked.
//
//  1. INSTANCE SPLIT. Registrants (`lib/cli/studio.ts`, `electron/main.ts` via
//     shell-api) load the compiled `dist-cli` copy of this module, while
//     `/api/server-status/reset` is app code Turbopack bundles into its own
//     server chunk with its own copy. Two module instances, two `handler`
//     variables — the registration could never be visible to the reader.
//  2. DEAD-CODE ELIMINATION. With a module-level `let`, nothing in the ROUTE's
//     bundle graph ever calls `setRelaunchHandler`, so Turbopack proves
//     `handler === null` and drops the branch entirely. Verified in the built
//     artifact: the compiled route reads
//     `setTimeout(()=>process.exit(75),100)` with no null check at all.
//     An opaque `globalThis` property read cannot be proven null, so the
//     branch survives compilation.
//
// This matches the repo's existing cross-instance singleton pattern
// (`lib/db/client.ts`, `lib/jobs/manager.ts`, `lib/terminal/instance.ts`).
//
// Impact of the old shape: "Restart server" (always visible in MCPs & Skills)
// quit the packaged app without relaunching, and killed an `npx` server with
// no message at all — the explanatory line lived in the dead handler.
const slot = globalThis as unknown as { __libiRelaunchHandler?: Handler | null };

export function setRelaunchHandler(fn: Handler): void {
  slot.__libiRelaunchHandler = fn;
}

export function requestRelaunch(): void {
  const handler = slot.__libiRelaunchHandler;
  if (handler) {
    handler();
  } else {
    // No handler registered (e.g., bare `next dev` started without scripts/dev.ts).
    // Fall back to the exit-75 contract.
    setTimeout(() => process.exit(75), 100);
  }
}
