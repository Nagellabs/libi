// lib/runtime/current-runtime.ts
//
// "Which runtime am I, and which shell is driving me?" — answered from inside
// the RUNTIME (the Next.js server), which is the process the update check and
// the Settings UI live in.
//
// ## Why this needs the shell's help
//
// The shell↔runtime contract (`lib/runtime/shell-api.ts`) is a single integer
// and the shell pins a `[MIN, MAX]` RANGE of it
// (`electron/runtime-loader.ts`). The runtime can read its OWN
// `shellApiVersion` off its `package.json`, but the shell's supported range is
// compiled into `dist-electron/main.js` — data the runtime cannot read.
//
// Without that range, "is the published 0.2.0 something this desktop app can
// actually run?" is unanswerable, and Task 9 Step 2 (compatible vs
// incompatible) collapses into a guess. So `electron/main.ts` publishes four
// values into `process.env` the moment it resolves a runtime — cheap, and it
// works because in a packaged build the Next server runs IN the Electron main
// process, so those assignments are visible here.
//
// ## …and why it still works without it
//
// Every env read below has a fallback, so an older shell (or a shell whose
// publication step is lost in a merge) degrades instead of breaking:
//
//   * version / shellApiVersion → read from the runtime's own `package.json`
//     at `process.cwd()`, which `main.ts` chdir'd to the runtime root.
//   * the shell's range → `[own, own]`. That is the conservative truth: the
//     running shell demonstrably accepts THIS runtime's `shellApiVersion`
//     (it loaded it), and we know nothing else. A published version declaring
//     a different integer is then treated as needing a newer desktop app,
//     which errs toward "don't offer an install that cannot work".
import fs from "node:fs";
import path from "node:path";

import { serverLogger as logger } from "@/lib/logger";
import { detectIsPackaged } from "@/lib/runtime/registry-url";

/** Env vars `electron/main.ts` publishes once a runtime is resolved. */
export const RUNTIME_VERSION_ENV = "LIBI_RUNTIME_VERSION";
export const RUNTIME_SOURCE_ENV = "LIBI_RUNTIME_SOURCE";
export const SHELL_API_MIN_ENV = "LIBI_SHELL_API_MIN";
export const SHELL_API_MAX_ENV = "LIBI_SHELL_API_MAX";

const LOG_TAG = "runtime-update";

/** Where this runtime came from. `"dev"` = a working tree, not a snapshot. */
export type RuntimeSource = "bundled" | "user" | "dev";

export interface ShellApiRange {
  min: number;
  max: number;
}

export interface CurrentRuntime {
  /** Version of the running `@nagellabs/libi`, or null if unreadable. */
  version: string | null;
  /** Its `libi.shellApiVersion`, or null if unreadable. */
  shellApiVersion: number | null;
  source: RuntimeSource;
  /** The range the DRIVING SHELL can load. See the header for the fallback. */
  shellApi: ShellApiRange | null;
  /**
   * Can this install replace its runtime at all? True only for a packaged
   * desktop shell. A dev checkout IS the runtime; an `npx @nagellabs/libi`
   * user upgrades with npm. Offering an in-app install in either case would
   * be offering something that cannot work.
   */
  updatesSupported: boolean;
}

export interface DescribeCurrentRuntimeOptions {
  env?: Record<string, string | undefined>;
  /** Defaults to `process.cwd()` — the runtime root in a packaged boot. */
  cwd?: string;
  /** Override for tests; defaults to `detectIsPackaged()`. */
  isPackaged?: boolean;
}

function readIntEnv(
  env: Record<string, string | undefined>,
  key: string,
): number | null {
  const raw = env[key]?.trim();
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/** Read `<cwd>/package.json`. Never throws. */
export function readRuntimeManifest(cwd: string): {
  version: string | null;
  shellApiVersion: number | null;
} {
  try {
    const raw = fs.readFileSync(path.join(cwd, "package.json"), "utf-8");
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      version?: unknown;
      libi?: { shellApiVersion?: unknown };
    };
    const version = typeof parsed.version === "string" ? parsed.version : null;
    const api = parsed.libi?.shellApiVersion;
    return {
      version,
      shellApiVersion: Number.isInteger(api) ? (api as number) : null,
    };
  } catch {
    return { version: null, shellApiVersion: null };
  }
}

export function describeCurrentRuntime(
  opts: DescribeCurrentRuntimeOptions = {},
): CurrentRuntime {
  const env = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const isPackaged = opts.isPackaged ?? detectIsPackaged();

  const manifest = readRuntimeManifest(cwd);
  const version = env[RUNTIME_VERSION_ENV]?.trim() || manifest.version;

  const rawSource = env[RUNTIME_SOURCE_ENV]?.trim();
  const source: RuntimeSource =
    rawSource === "bundled" || rawSource === "user"
      ? rawSource
      : isPackaged
        ? "bundled"
        : "dev";

  const shellApiVersion = manifest.shellApiVersion;
  const min = readIntEnv(env, SHELL_API_MIN_ENV);
  const max = readIntEnv(env, SHELL_API_MAX_ENV);
  let shellApi: ShellApiRange | null = null;
  if (min !== null && max !== null && min <= max) {
    shellApi = { min, max };
  } else if (shellApiVersion !== null) {
    // Conservative fallback — see the header. The shell loaded THIS runtime,
    // so it accepts this integer; assume nothing beyond that.
    shellApi = { min: shellApiVersion, max: shellApiVersion };
    if (isPackaged && (min !== null || max !== null)) {
      logger.warn(
        { tag: LOG_TAG, op: "shell_api_range_partial", min, max },
        "shell published only half a shellApiVersion range — falling back to the runtime's own version",
      );
    }
  }

  return {
    version,
    shellApiVersion,
    source,
    shellApi,
    updatesSupported: isPackaged,
  };
}
