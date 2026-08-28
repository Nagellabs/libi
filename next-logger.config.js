// next-logger picks up this file at the project root. It exports a `logger`
// factory that next-logger calls with its default config; we return a pino
// instance with a multi-target transport so every Next.js framework log line
// (compile output, request logs, and — in dev only, the relay is a
// dev-server feature — browser-relayed errors via `[browser]`)
// gets written to BOTH the terminal AND ~/.libi/logs/server.log.
//
// This file MUST be CommonJS — next-logger requires() it directly during
// process startup before the Next.js bundler runs.
//
// Two things outside this file are load-bearing, and both have been missing
// before (with the effect that server.log was never created ANYWHERE):
//   1. `instrumentation.ts` must `await import("next-logger")`. Nothing else
//      loads it — being a dependency and a serverExternalPackage does nothing.
//   2. `package.json#files` must list `next-logger.config.js`. `files` is an
//      allowlist; a root-level file not named there is absent from the npm
//      tarball, so an installed copy silently falls back to next-logger's
//      default stdout-only pino config.
// Both are pinned by __tests__/unit/scripts/next-logger-wiring.test.ts.
//
// It is found via lilconfig's upward search from `process.cwd()`. Every launch
// path chdirs to the package/checkout root before the server starts —
// bin/libi.js (dev checkout), lib/cli/studio.ts (`npx` install, chdirs to
// `projectRoot` before Category A), electron/main.ts (packaged, to the runtime
// root) — so "package root" is the one place to keep it.
//
// App-level structured logs (mcpLogger / serverLogger / ffmpegLogger /
// proxyLogger / etc.) keep going to ~/.libi/logs/libi.log via lib/logger.ts;
// this server.log is exclusively for Next's own output.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pino = require("pino");

const homeRoot = process.env.LIBI_HOME || path.join(os.homedir(), ".libi");
const logDir = path.join(homeRoot, "logs");
fs.mkdirSync(logDir, { recursive: true });

const logFile = path.join(logDir, "server.log");

// Truncate the file if it grows past 5 MB so the disk doesn't fill up over
// long dev sessions. Production servers should use proper log rotation.
try {
  const stat = fs.statSync(logFile);
  if (stat.size > 5_000_000) fs.truncateSync(logFile, 0);
} catch {
  // file doesn't exist yet — pino will create it on first write
}

const isDev = process.env.NODE_ENV !== "production";

const transport = pino.transport({
  targets: [
    {
      // Pretty stdout so the dev terminal stays readable.
      target: "pino-pretty",
      level: "trace",
      options: {
        destination: 1, // 1 = stdout
        colorize: isDev,
        translateTime: "SYS:HH:MM:ss.l",
        ignore: "pid,hostname,name",
        singleLine: true,
      },
    },
    {
      // Pretty file (no color codes) so `tail -f` is human-readable AND
      // parseable. Switch to JSON if you ever need to ingest into Loki/Datadog.
      target: "pino-pretty",
      level: "trace",
      options: {
        destination: logFile,
        append: true,
        mkdir: true,
        colorize: false,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname",
      },
    },
  ],
});

const logger = (defaultConfig) =>
  pino(
    {
      ...defaultConfig,
      level: "trace",
    },
    transport,
  );

module.exports = { logger };
