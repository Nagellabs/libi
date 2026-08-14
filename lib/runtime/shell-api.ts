// lib/runtime/shell-api.ts
//
// THE ONE MODULE THE DESKTOP SHELL IS ALLOWED TO REACH INTO.
//
// ## The model
//
// The Electron shell (`electron/`) and the libi runtime (`@nagellabs/libi` on
// npm) ship on DIFFERENT cadences. A feature release is `npm publish`; every
// desktop install picks it up on next launch. The shell only re-ships for
// Chromium CVEs, native ABI bumps, and breaking changes to *this* file.
//
// That is only safe because the coupling between them is finite and versioned.
// Before this module existed, `electron/main.ts` imported
// `lib/server/lifecycle`, `lib/server/lifecycle/adapters/electron`,
// `lib/server/lifecycle/relaunch`, `mcp/notify` and `lib/sentry/native-crash`
// directly — five unversioned reach-ins that were compiled into the shell, so
// "the runtime" and "the shell" were the same build by construction and could
// never be released apart.
//
// Everything the shell needs is re-exported here and NOWHERE else. The shell
// loads exactly `<runtime-root>/dist-cli/lib/runtime/shell-api.js` (see
// `electron/runtime-loader.ts`) and touches no other runtime file.
//
// ## SHELL_API_VERSION — the contract
//
// A single integer. The shell pins a `[MIN, MAX]` range
// (`electron/runtime-loader.ts`); a runtime outside that range is REJECTED and
// the shell falls back to its bundled snapshot, telling the user to update the
// desktop app. This is precisely what lets a runtime ship weekly without the
// shell shipping weekly: an old shell will refuse a runtime it cannot drive,
// rather than half-loading it.
//
// **When to bump it — and when not to.**
//
//   * Bump (BREAKING): removing an export, renaming one, changing a signature
//     in a way an older shell cannot call, or changing the meaning of a return
//     value. An older shell must not be able to load the new runtime.
//   * Do NOT bump: adding a NEW export, or any change confined to the runtime's
//     internals. An older shell simply won't call the new export. Bumping for
//     an additive change would strand every already-installed shell on its
//     bundled snapshot for no reason.
//
// The same integer is duplicated at `package.json#libi.shellApiVersion` so the
// shell can gate on it by reading STATIC JSON — before it executes a single
// line of a candidate runtime. `__tests__/unit/runtime/shell-api-contract.test.ts`
// enforces that the two never drift, and that every export the shell's loader
// type-depends on is actually present.

/**
 * The shell↔runtime contract version. See the header for the bump rules.
 *
 * Duplicated at `package.json#libi.shellApiVersion` (checked by test).
 */
export const SHELL_API_VERSION = 1;

/** Category A + the install-phase splash flow. */
export { runInstallPhase } from "@/lib/server/lifecycle";
/** Bridges lifecycle events onto the splash window's `lifecycle` IPC channel. */
export { electronAdapter } from "@/lib/server/lifecycle/adapters/electron";
/** Lets `/api/server-status/reset` relaunch the desktop app. */
export { setRelaunchHandler } from "@/lib/server/lifecycle/relaunch";
/**
 * Lets the shell publish its electron-updater channel to the update route.
 * ADDITIVE (no version bump): the shell feature-detects it, so a runtime
 * published before it existed still loads fine.
 */
export { registerShellUpdater } from "@/lib/runtime/shell-update";
/** Lets the server raise native desktop notifications through the shell. */
export { bindNotifier } from "@/mcp/notify";
/** Main-process crash / abnormal-exit reporting (Sentry, real installs only). */
export { reportNativeCrash } from "@/lib/sentry/native-crash";
/** Boots the production Next server in-process and returns its bound port. */
export { startNextServer } from "@/lib/server/next-server";

export type { LifecycleAdapter, LifecycleEvent } from "@/lib/server/lifecycle";
export type { ShellUpdater, ShellUpdateStatus } from "@/lib/runtime/shell-update";
export type { Notifier, PushPayload } from "@/mcp/notify";
export type {
  StartNextServerOptions,
  StartedNextServer,
} from "@/lib/server/next-server";
