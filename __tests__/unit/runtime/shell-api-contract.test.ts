// The shell↔runtime contract (lib/runtime/shell-api.ts).
//
// Two things must never drift, and neither is visible until a packaged app
// refuses to boot:
//
//   1. `SHELL_API_VERSION` and `package.json#libi.shellApiVersion`. The loader
//      gates on the JSON copy (it can read it without executing anything) and
//      then re-checks the module's copy after loading — so if they disagree,
//      EVERY runtime is rejected as `shell-api-version-disagrees` and the app
//      falls back forever.
//   2. The set of exports `electron/main.ts` calls through `runtime.api`.
//      Deleting or renaming one is a BREAKING change that requires bumping
//      SHELL_API_VERSION; this test makes the omission loud.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import * as shellApi from "@/lib/runtime/shell-api";
import { MAX_SHELL_API_VERSION, MIN_SHELL_API_VERSION } from "@/electron/runtime-loader";

const repoPkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8"),
) as { libi?: { shellApiVersion?: number } };

/**
 * Everything `electron/main.ts` reaches for through `runtime.api`. Adding to
 * this list is fine; removing from it means an older shell can no longer drive
 * the runtime, which is exactly what SHELL_API_VERSION exists to signal.
 */
const REQUIRED_EXPORTS = [
  "runInstallPhase",
  "electronAdapter",
  "setRelaunchHandler",
  // The shell FEATURE-DETECTS this one (older runtimes predate it), so
  // removing it would not strand a shell — it would silently turn shell
  // updates off, which is exactly the kind of drift this list makes loud.
  "registerShellUpdater",
  "bindNotifier",
  "reportNativeCrash",
  "startNextServer",
] as const;

describe("shell API contract", () => {
  it("declares the same version in the module and in package.json", () => {
    expect(repoPkg.libi?.shellApiVersion).toBe(shellApi.SHELL_API_VERSION);
  });

  it("declares an integer version", () => {
    expect(Number.isInteger(shellApi.SHELL_API_VERSION)).toBe(true);
  });

  it("is inside the range this shell claims to support", () => {
    expect(shellApi.SHELL_API_VERSION).toBeGreaterThanOrEqual(MIN_SHELL_API_VERSION);
    expect(shellApi.SHELL_API_VERSION).toBeLessThanOrEqual(MAX_SHELL_API_VERSION);
  });

  it.each(REQUIRED_EXPORTS)("exports %s as a callable", (name) => {
    expect(typeof (shellApi as unknown as Record<string, unknown>)[name]).toBe(
      "function",
    );
  });
});
