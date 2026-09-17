// lib/playwright/paths.ts
//
// Where playwright-core keeps its CLI and its browser manifest. A LEAF module
// on purpose: it imports nothing of libi's, so the Chromium installer
// (`mcp/registry/installers.ts`), the boot prune
// (`lib/server/lifecycle/housekeeping.ts`) and the export-time download
// (`lib/export/ensure-chromium.ts`) can all read the same answers without
// importing each other — the installer needs the prune's marker helper, and
// the prune needs the CLI path, which was a cycle while this lived in
// `installers.ts`.
import fs from "node:fs";
import path from "node:path";

/** Walk up from cwd to find `node_modules/playwright-core/cli.js`. Server-only.
 *  cwd-relative by design: `startStudio` chdirs to the package root BEFORE
 *  Category A runs (see `lib/cli/studio.ts`), and under the packaged app that
 *  root is the runtime snapshot. */
export function resolvePlaywrightCoreCli(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = path.join(dir, "node_modules", "playwright-core", "cli.js");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "Could not locate node_modules/playwright-core/cli.js relative to cwd. " +
      "Ensure playwright-core is installed.",
  );
}

export interface PlaywrightBrowserEntry {
  name: string;
  revision: string;
}

/** The `browsers` list out of playwright-core's own `browsers.json` — the
 *  revisions this exact playwright-core can launch. Located beside `cli.js`,
 *  NOT via `require.resolve("playwright-core/browsers.json")`: the package's
 *  `exports` map does not expose that file, so the resolve throws
 *  (`ERR_PACKAGE_PATH_NOT_EXPORTED`) and a caller built on it silently sees
 *  nothing. Throws when the manifest cannot be read — callers decide whether
 *  that is fatal (the prune keeps everything; the installer has no revision
 *  to mark). */
export function readPlaywrightBrowsersManifest(): PlaywrightBrowserEntry[] {
  const manifestPath = path.join(path.dirname(resolvePlaywrightCoreCli()), "browsers.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
    browsers?: Array<{ name?: unknown; revision?: unknown }>;
  };
  return (manifest.browsers ?? []).flatMap((b) =>
    typeof b.name === "string" && typeof b.revision === "string" && b.revision.length > 0
      ? [{ name: b.name, revision: b.revision }]
      : [],
  );
}

/** The revision `playwright install chromium` fetches (the `chromium` entry;
 *  today "1217"), or null when the manifest cannot be read. This is the
 *  `<rev>` in the cache directory name `chromium-<rev>`. */
export function playwrightChromiumRevision(): string | null {
  try {
    return readPlaywrightBrowsersManifest().find((b) => b.name === "chromium")?.revision ?? null;
  } catch {
    return null;
  }
}
