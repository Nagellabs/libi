#!/usr/bin/env node
/**
 * Boot libi with Sentry FORCED ON, aimed by default at a local dead-end.
 *
 * WHY THIS EXISTS
 * ---------------
 * `bin/libi.js` sets `NEXT_PUBLIC_LIBI_SENTRY="0"` whenever it detects a dev
 * checkout (a `.git` directory), so contributors never pollute the production
 * Sentry project. That is correct — but it also means the crash-report opt-out
 * gate (`lib/sentry/gated-transport.ts`) cannot be observed end-to-end from
 * this repo, because nothing ever leaves. The launcher only picks that default
 * when the variable is UNSET, so exporting it first overrides the choice.
 *
 * WHY THE DSN IS REDIRECTED
 * -------------------------
 * With Sentry genuinely on, envelopes would land in the real libi Sentry
 * project and look like production crashes. So by default this points the DSN
 * at the app's OWN origin: the SDK still performs a real POST — which is
 * exactly what you are measuring, "does an envelope leave the transport?" —
 * but it lands on a 404 in the local Next server and never reaches Sentry.
 *
 * HOW TO USE IT
 * -------------
 *   node scripts/dev-sentry-live.js              # Sentry on, DSN → local sink
 *   node scripts/dev-sentry-live.js --isolated   # ...plus a throwaway LIBI_HOME
 *   node scripts/dev-sentry-live.js --real-dsn   # ⚠️  sends to the REAL project
 *
 * Then, in the browser devtools/network panel, filter on `envelope` and:
 *   1. trigger an error       → POSTs appear
 *   2. Settings → Privacy, turn crash reports OFF, trigger again, NO reload
 *                             → no new POSTs
 *   3. turn it back ON, trigger again
 *                             → POSTs resume in the same session
 *
 * `--isolated` additionally points LIBI_HOME at a scratch directory, which is
 * what you want for upgrade-boot testing: seed that DB at an older migration
 * and confirm the boot-time preference read fails safely (it is wrapped in a
 * guarded try/catch that logs `op:"crash_report_seed_failed"` and falls back to
 * reporting) rather than taking the server down.
 */
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);

const isolated = has("--isolated");
const realDsn = has("--real-dsn");
const port = String(
  Number(argv[argv.indexOf("--port") + 1]) || (isolated ? 3458 : 3456),
);

// A valid DSN shape (<scheme>://<publicKey>@<host>[:port]/<projectId>) aimed at
// the app itself, so envelope POSTs are observable but provably local.
const SINK_DSN = `http://0000000000000000000000000000dead@localhost:${port}/999`;

const env = { ...process.env, NEXT_PUBLIC_LIBI_SENTRY: "1", LIBI_PORT: port };

if (realDsn) {
  console.log(
    "⚠️  --real-dsn: events WILL be sent to the production Sentry project.",
  );
} else {
  env.NEXT_PUBLIC_SENTRY_DSN = SINK_DSN;
}

if (isolated) {
  env.LIBI_HOME = path.join(os.tmpdir(), "libi-sentry-live-home");
  console.log(`   LIBI_HOME → ${env.LIBI_HOME} (throwaway)`);
}

console.log(
  `→ booting libi on :${port} with Sentry ENABLED, DSN → ${realDsn ? "PRODUCTION" : "local sink"}`,
);

const child = spawn(process.execPath, [path.join(ROOT, "bin", "libi.js")], {
  cwd: ROOT,
  env,
  stdio: "inherit",
});

child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
