// electron/sync-log.ts
import path from "path";
import os from "os";
import fs from "fs";

/**
 * Sync log to surface main-process lifecycle issues that pino's
 * worker-thread transport may not flush before a crash.
 *
 * Shared between `electron/main.ts` and any module that needs to leave a
 * durable trace of something that happened before/without the Next.js
 * runtime (and therefore before pino is available) — e.g.
 * `electron/path-bootstrap.ts`'s login-shell PATH probe, which by design
 * runs in the background and can silently hang (see that module's docblock).
 * Extracted out of `main.ts` specifically so `path-bootstrap.ts` doesn't have
 * to import `main.ts` (which pulls in `electron` app-lifecycle side effects)
 * just to log.
 */
export function mainSyncLog(line: string): void {
  try {
    const logDir = path.join(
      process.env.LIBI_HOME ?? path.join(os.homedir(), ".libi"),
      "logs",
    );
    fs.mkdirSync(logDir, { recursive: true });
    fs.appendFileSync(
      path.join(logDir, "electron-main-sync.log"),
      `[${new Date().toISOString()}] ${line}\n`,
    );
  } catch { /* never throw */ }
}
