/**
 * Where libi's provider setup scripts are on THIS machine. Server only.
 *
 * The scripts ship in the npm package under `lib/agents/setup/scripts/`
 * (`package.json#files` carries `lib/**`), and the desktop app's runtime bundle
 * is an install of that same package tarball, unpacked on disk. So every
 * distribution has them as real files at `<package root>/lib/agents/setup/scripts`,
 * and `packageRoot` finds that root in each run mode.
 */
import fs from "node:fs";
import path from "node:path";
import { packageRoot } from "@/lib/runtime/package-root";
import { SETUP_SCRIPT_NAMES } from "./commands";

export function setupScriptsDir(root: string = packageRoot()): string {
  return path.join(root, "lib", "agents", "setup", "scripts");
}

/** Exact file names only. Another file, a path, or an encoded name is not a setup script. */
export function isSetupScriptName(name: string): boolean {
  return SETUP_SCRIPT_NAMES.includes(name);
}

/**
 * The text of an allowlisted script, or `null` for any other name or a file that
 * is not there. The name is checked before it is joined into a path, and nothing
 * is ever run.
 */
export function readSetupScript(name: string, dir: string = setupScriptsDir()): string | null {
  if (!isSetupScriptName(name)) return null;
  try {
    return fs.readFileSync(path.join(dir, name), "utf8");
  } catch {
    return null;
  }
}

/** The allowlisted scripts missing from `dir`: empty when the install is whole. */
export function missingSetupScripts(dir: string = setupScriptsDir()): string[] {
  return SETUP_SCRIPT_NAMES.filter((name) => !fs.existsSync(path.join(dir, name)));
}
