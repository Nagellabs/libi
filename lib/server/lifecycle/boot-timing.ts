// lib/server/lifecycle/boot-timing.ts
//
// Where a production boot's time goes, as ONE `lifecycle` line (EL-4, Windows
// verification F3). The installed Windows first boot sat ~4 min between
// Category A and a published port, while the same runtime copied elsewhere took
// 45 s; the likely costs are Defender scanning a fresh tree and the externals
// farm build. This line is what the RDP check reads instead of guessing:
//
//   op: "farm_built"     there was no farm dir before this boot and links were
//                        made (Windows' first boot of a runtime: the installer
//                        ships none)
//   op: "farm_repaired"  a farm dir was there and links were still made — the
//                        old delete-and-relink of dereferenced copies, which
//                        `farmCopiesReplaced` counts, or a macOS repair
//   op: "boot_timing"    the farm was only verified
//
// with `farmMs` (the farm build/verify), `categoryAToPortMs` (Category A start
// → the studio port bound and published into the env) and
// `categoryAToReadyMs` (→ Next prepared, i.e. through Category B).
//
// A module-level mark, not a parameter: `runInstallPhase` and the server start
// are two separate calls from the shell (electron/main.ts) and the CLI
// (lib/cli/studio.ts), and threading a timestamp between them would change the
// shell API for a log line.
import fs from "node:fs";
import path from "node:path";
import { serverLogger as logger } from "@/lib/logger";

let installPhaseStartedAt: number | null = null;

/** Called by `runInstallPhase` as Category A begins. */
export function markInstallPhaseStart(now: number = Date.now()): void {
  installPhaseStartedAt = now;
}

/** Milliseconds since Category A began in this process, or null when it never ran here. */
export function msSinceInstallPhaseStart(now: number = Date.now()): number | null {
  return installPhaseStartedAt === null ? null : now - installPhaseStartedAt;
}

export function resetBootTimingForTests(): void {
  installPhaseStartedAt = null;
}

/**
 * What the externals farm looked like BEFORE this boot touched it: whether its
 * directory existed, and how many of its entries were real directories (the
 * dereferenced copies an installer used to ship) rather than links. Read it
 * before `ensureNextExternalSymlinks`. Never throws.
 */
export function inspectFarmBeforeBoot(nextDir: string): { farmExisted: boolean; farmCopiesReplaced: number } {
  const farm = path.join(nextDir, "node_modules");
  let top: fs.Dirent[];
  try {
    top = fs.readdirSync(farm, { withFileTypes: true });
  } catch {
    return { farmExisted: false, farmCopiesReplaced: 0 };
  }
  let copies = 0;
  for (const entry of top) {
    if (!entry.isDirectory()) continue; // a link (Dirent never follows it) or a file
    if (entry.name.startsWith("@")) {
      // A scope folder (`@napi-rs/canvas-<hash>`): count what is inside it.
      try {
        copies += fs.readdirSync(path.join(farm, entry.name), { withFileTypes: true }).filter((e) => e.isDirectory()).length;
      } catch {
        /* unreadable scope: count nothing */
      }
    } else {
      copies += 1;
    }
  }
  return { farmExisted: true, farmCopiesReplaced: copies };
}

/** The sync-log suffix the shell's line carries. */
export function describeFarmBeforeBoot(f: { farmExisted: boolean; farmCopiesReplaced: number }): string {
  return f.farmExisted
    ? `(farm dir existed before boot: yes, ${f.farmCopiesReplaced} real-directory cop${f.farmCopiesReplaced === 1 ? "y" : "ies"})`
    : "(farm dir existed before boot: no)";
}

export interface BootTiming {
  /** Which production server: the packaged app's (`startNextServer`) or npx's (`lib/cli/studio.ts`). */
  surface: "electron" | "cli";
  farmMs: number;
  farmCreated: number;
  farmVerified: number;
  /** Whether `.next/node_modules` existed before this boot (`inspectFarmBeforeBoot`). */
  farmExisted: boolean;
  /** Real-directory entries in it before this boot — copies the relink replaced. */
  farmCopiesReplaced: number;
  /** When the port was bound and published. */
  portAt: number;
  /** When Next finished preparing (Category B included). */
  readyAt: number;
}

export function logBootTiming(t: BootTiming): void {
  const categoryAToPortMs = msSinceInstallPhaseStart(t.portAt);
  const categoryAToReadyMs = msSinceInstallPhaseStart(t.readyAt);
  const op = t.farmCreated === 0 ? "boot_timing" : t.farmExisted ? "farm_repaired" : "farm_built";
  logger.info(
    {
      tag: "lifecycle",
      op,
      surface: t.surface,
      farmMs: t.farmMs,
      farmCreated: t.farmCreated,
      farmVerified: t.farmVerified,
      farmExisted: t.farmExisted,
      farmCopiesReplaced: t.farmCopiesReplaced,
      categoryAToPortMs,
      categoryAToReadyMs,
    },
    `boot: externals farm ${op === "boot_timing" ? "verified" : op === "farm_built" ? "built" : "repaired"} in ${t.farmMs}ms; ` +
      `Category A → port ${categoryAToPortMs ?? "?"}ms, → ready ${categoryAToReadyMs ?? "?"}ms`,
  );
}
