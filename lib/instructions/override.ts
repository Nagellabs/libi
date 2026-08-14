import fs from "node:fs";
import path from "node:path";
import { getLibiInstructionsDir } from "@/lib/libi-home";
import { loadBundledTemplate } from "./bundled-template";

export type ForkStaleness = boolean | "unknown";

export interface InstructionsStatus {
  source: "bundled" | "override";
  /** Only meaningful when source === "override": true = bundled template
   *  changed since the fork; false = identical; "unknown" = snapshot missing. */
  bundledUpdatedSinceFork: ForkStaleness;
}

export function getInstructionsOverridePath(): string {
  return path.join(getLibiInstructionsDir(), "instructions.md");
}

/** Snapshot of the bundled template at fork time — drives staleness. */
export function getInstructionsOverrideBasePath(): string {
  return path.join(getLibiInstructionsDir(), ".base.md");
}

export function hasInstructionsOverride(): boolean {
  return fs.existsSync(getInstructionsOverridePath());
}

export function readInstructionsOverride(): string | null {
  try {
    return fs.readFileSync(getInstructionsOverridePath(), "utf-8");
  } catch {
    return null;
  }
}

/** Create-or-update the override. Snapshots the bundled template on first call. */
export function saveInstructionsOverride(content: string): void {
  if (content.trim().length === 0) {
    throw new Error("Override content must not be empty — revert instead");
  }
  const dir = getLibiInstructionsDir();
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(getInstructionsOverrideBasePath())) {
    fs.writeFileSync(getInstructionsOverrideBasePath(), loadBundledTemplate());
  }
  fs.writeFileSync(getInstructionsOverridePath(), content);
}

/** Delete the override + snapshot, restoring the bundled template. */
export function revertInstructionsOverride(): void {
  fs.rmSync(getInstructionsOverridePath(), { force: true });
  fs.rmSync(getInstructionsOverrideBasePath(), { force: true });
}

export function getInstructionsStatus(): InstructionsStatus {
  if (!hasInstructionsOverride()) {
    return { source: "bundled", bundledUpdatedSinceFork: false };
  }
  let staleness: ForkStaleness;
  try {
    const base = fs.readFileSync(getInstructionsOverrideBasePath(), "utf-8");
    staleness = loadBundledTemplate() !== base;
  } catch {
    staleness = "unknown";
  }
  return { source: "override", bundledUpdatedSinceFork: staleness };
}
