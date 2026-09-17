// lib/runtime/shell-env-state.ts
//
// The runtime side of the shell→runtime environment seam. The packaged desktop app reads the
// user's login-shell environment in the background (`electron/path-bootstrap.ts`) and publishes
// how far it got in `process.env.LIBI_SHELL_ENV`. The packaged Next server runs IN the Electron
// main process, so the value is simply visible here — the same mechanism
// `lib/runtime/current-runtime.ts` uses for the variables `electron/main.ts` publishes. No
// `shell-api` change. A leaf: no imports, so the process manager and the session manager can
// both read it.

/** Must equal `electron/path-bootstrap.ts#SHELL_ENV_STATE_VAR` (pinned by a test). */
export const SHELL_ENV_STATE_VAR = "LIBI_SHELL_ENV";

export type ShellEnvState = "pending" | "loaded" | "failed" | "inherited";

/** Absent (npx, dev, Windows) → `inherited`: libi was started by something that already had the
 *  user's environment. A value only the shell can write, so anything unrecognised is `failed`. */
export function readShellEnvState(env: Partial<NodeJS.ProcessEnv> = process.env): ShellEnvState {
  const value = env[SHELL_ENV_STATE_VAR];
  if (value === undefined) return "inherited";
  if (value === "pending" || value === "loaded" || value === "failed") return value;
  return "failed";
}

export function isShellEnvLoaded(env: Partial<NodeJS.ProcessEnv> = process.env): boolean {
  const state = readShellEnvState(env);
  return state === "loaded" || state === "inherited";
}
