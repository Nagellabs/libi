/**
 * Classify a binary-install failure message into the RIGHT hint block.
 *
 * Observed 2026-07-24: a better-sqlite3 ABI mismatch (postinstall rebuilds
 * native deps for Electron's ABI; the server runs under system Node)
 * surfaced Category A's generic "no network / disk full / SHA256" hints —
 * all wrong, and the actual one-line fix went unmentioned.
 */

import {
  extractUnreachableHost,
  looksUnreachable,
  SUPPORT_LINE,
} from "@/lib/runtime/network-errors";

const ABI_RE =
  /NODE_MODULE_VERSION|was compiled against a different Node\.js version|ERR_DLOPEN_FAILED/;

export function binaryInstallHints(message: string): string {
  if (ABI_RE.test(message)) {
    return [
      "Native module ABI mismatch — a compiled dependency (e.g. better-sqlite3) was",
      "built for a different Node/Electron version. `npm install` causes this: its",
      "postinstall rebuilds native deps for Electron's ABI, breaking system-Node runs.",
      "",
      "Fix:  node scripts/ensure-native-modules.js",
      "(or launch via `npm run dev` / `npm run dev:electron`, which run it automatically)",
    ].join("\n");
  }
  // A REQUIRED first-run install that cannot complete because the network is
  // unreachable is its own failure, and it gets its own words. The generic
  // "common causes" list below buries the one thing the user can act on, and a
  // corporate proxy typically blocks github.com while npm keeps working — so
  // NAME the host that actually failed rather than blaming "the network".
  //
  // NB: this is the fatal branch only. An unreachable host while a working
  // runtime is already installed must stay silent — see
  // `lib/runtime/runtime-install.ts#describeRuntimeInstallFailure` and the
  // plan's three-outcome table. Do not reuse this text there.
  if (looksUnreachable(message)) {
    const host = extractUnreachableHost(message);
    return [
      host
        ? `Libi can't finish installing — ${host} is unreachable.`
        : "Libi can't finish installing — a required download could not be reached.",
      "Check your connection or proxy, then reopen libi.",
      "",
      "Libi downloads from more than one host, and they can fail independently:",
      "  • the npm registry (registry.npmjs.org, or your configured mirror)",
      "  • github.com — release binaries (ffmpeg, yt-dlp) and native prebuilds",
      "  • electronjs.org — Electron headers",
      "",
      SUPPORT_LINE,
    ].join("\n");
  }

  return [
    "Common causes:",
    "  1. No network connection to GitHub release URLs",
    "  2. Disk space exhausted (~/.libi/bin/ requires ~500 MB)",
    "  3. SHA256 mismatch (upstream URL changed)",
    "",
    "Search the error message above for more context, then retry libi.",
    "",
    SUPPORT_LINE,
  ].join("\n");
}
