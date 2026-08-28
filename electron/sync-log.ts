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

/**
 * Renderer `console.error` → disk, for the packaged app only in practice.
 *
 * Next's `[browser]` relay into `server.log` is a DEV-SERVER feature
 * (`next/dist/server/dev/browser-logs/`). In a production build nothing
 * forwards renderer console output anywhere, and the packaged app is the one
 * environment where the user also has no DevTools and no terminal — a
 * client-side failure there used to exist on disk nowhere. Sentry catches
 * *uncaught* exceptions (when the user hasn't opted out), but plain
 * `console.error` diagnostics — often the only breadcrumb before a blank
 * screen — were lost entirely.
 *
 * Deliberately narrow:
 *  - errors only — `info`/`warning`/`debug` are volume without support value
 *    (see lib/engine/media-console-noise.ts for how chatty media code gets);
 *  - messages truncated, and the forwarder goes silent after a cap, so an
 *    error thrown per animation frame can't grow the log unboundedly via
 *    `appendFileSync`;
 *  - local disk only, same file as the rest of the main-process trace. This
 *    is the user's own app logging to the user's own machine — nothing is
 *    transmitted.
 *
 * Factory shape (state in a closure, `write` injected) so the cap and
 * truncation are unit-testable without an Electron process.
 */
export interface RendererConsoleMessage {
  level: "info" | "warning" | "error" | "debug";
  message: string;
  sourceId: string;
  lineNumber: number;
}

export const RENDERER_CONSOLE_MAX_LINES = 500;
export const RENDERER_CONSOLE_MAX_MESSAGE_CHARS = 2_000;

export function createRendererConsoleForwarder(
  write: (line: string) => void = mainSyncLog,
): (msg: RendererConsoleMessage) => void {
  let forwarded = 0;
  return (msg) => {
    if (msg.level !== "error") return;
    if (forwarded >= RENDERER_CONSOLE_MAX_LINES) return;
    forwarded += 1;
    if (forwarded === RENDERER_CONSOLE_MAX_LINES) {
      write(
        `renderer console.error: cap of ${RENDERER_CONSOLE_MAX_LINES} lines reached — further renderer errors suppressed for this window`,
      );
      return;
    }
    const text =
      msg.message.length > RENDERER_CONSOLE_MAX_MESSAGE_CHARS
        ? `${msg.message.slice(0, RENDERER_CONSOLE_MAX_MESSAGE_CHARS)}… [truncated ${msg.message.length - RENDERER_CONSOLE_MAX_MESSAGE_CHARS} chars]`
        : msg.message;
    const source = msg.sourceId ? ` (${msg.sourceId}:${msg.lineNumber})` : "";
    write(`renderer console.error: ${text}${source}`);
  };
}
