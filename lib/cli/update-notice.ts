// lib/cli/update-notice.ts
//
// One terminal line when a newer `@nagellabs/libi` is published — the CLI
// counterpart of the desktop's Settings update card.
//
// Who this is for: `npm i -g @nagellabs/libi` users, who otherwise stay on
// their installed version forever (nothing re-resolves it). `npx` users see
// it too when npm's cache pins them to an older version; for them the fix is
// automatic on a later run, and the message says so.
//
// Rules, matching lib/runtime/update-check.ts:
//   - NEVER blocks startup — the caller fires this and moves on; the line
//     prints whenever the registry answers (startup takes seconds anyway).
//   - NEVER surfaces a failure. Offline, DNS, 404, timeout → silence. A
//     version notice that turns into an error is worse than no notice.
//   - Not called at all from a dev checkout (lib/cli/studio.ts gates it):
//     a checkout's version is meaningless against the registry.
//
// `LIBI_REGISTRY_URL` is honored here WITHOUT the packaged-app gate that
// `describeRegistryUrl` applies. That gate protects the desktop RUNTIME
// INSTALLER from being pointed at a rogue registry; this module only reads a
// version string and prints a line — no code is fetched — and honoring the
// override is what lets the Verdaccio harness exercise this path.
import fs from "node:fs";
import path from "node:path";

import { fetchLatestManifest, isNewer } from "@/lib/runtime/update-check";
import { normalizeRegistryUrl, PUBLIC_NPM_REGISTRY } from "@/lib/runtime/registry-url";
import { packageRoot } from "@/lib/runtime/package-root";

/** Short — this races the user's attention span at startup, not correctness. */
export const NOTICE_TIMEOUT_MS = 3000;

export interface UpdateNoticeOptions {
  /** Own version. Default: read from the package root's package.json. */
  currentVersion?: string;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  write?: (line: string) => void;
}

function ownVersion(): string | null {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(packageRoot(__dirname), "package.json"), "utf-8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version ? pkg.version : null;
  } catch {
    return null;
  }
}

function noticeRegistryUrl(env: Record<string, string | undefined>): string {
  const raw = env.LIBI_REGISTRY_URL?.trim();
  if (!raw) return PUBLIC_NPM_REGISTRY;
  const normalized = normalizeRegistryUrl(raw);
  return "rejected" in normalized ? PUBLIC_NPM_REGISTRY : normalized.url;
}

/**
 * Print the update notice if a newer version is published. Resolves to the
 * printed line (test seam) or null when nothing was printed. Never throws.
 */
export async function maybePrintUpdateNotice(
  opts: UpdateNoticeOptions = {},
): Promise<string | null> {
  try {
    const current = opts.currentVersion ?? ownVersion();
    if (!current) return null;

    const manifest = await fetchLatestManifest({
      registryUrl: noticeRegistryUrl(opts.env ?? process.env),
      fetchImpl: opts.fetchImpl,
      timeoutMs: opts.timeoutMs ?? NOTICE_TIMEOUT_MS,
    });
    if (!manifest || !isNewer(manifest.version, current)) return null;

    const line =
      `\n[libi] Update available: ${current} → ${manifest.version}\n` +
      `[libi]   npm install -g @nagellabs/libi@latest   (global installs)\n` +
      `[libi]   npx runs pick the new version up automatically.\n\n`;
    (opts.write ?? ((s: string) => process.stdout.write(s)))(line);
    return line;
  } catch {
    // A notice must never be the reason startup looks broken.
    return null;
  }
}
