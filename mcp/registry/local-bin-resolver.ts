import fs from "node:fs";
import path from "node:path";
import { getLibiNodeModulesRoot } from "@/lib/libi-home";
import { resolveNodeCommand } from "@/lib/runtime/node-runtime";
import { packageRoot } from "@/lib/runtime/package-root";
import {
  entryResolutionDiagnostic,
  resolveEntrySpawn,
} from "@/lib/runtime/compiled-entry";
import type { BundledMcpDef } from "./types";

export interface ResolvedSpawn {
  command: string;
  args: string[];
  /** "local" when the pinned package is installed under ~/.libi/node_modules/,
   *  "in-repo" when the def is an in-repo MCP and we resolved its tsx-direct
   *  entry from the source tree,
   *  "fallback" when we couldn't find it and we're falling back to the def's
   *  `command`/`args` (typically `npx`). */
  source: "local" | "in-repo" | "fallback";
}

/**
 * Resolve the spawn command for a bundled MCP.
 *
 * For defs that declare `npmPackage` + `pinnedVersion`, prefers the locally
 * installed copy under `~/.libi/node_modules/`. This is the bullet-proof
 * path — no `npx` registry roundtrip, no npm-lock contention with parallel
 * spawns, sub-100 ms cold start.
 *
 * Falls back to the def's own `command`/`args` (e.g. `npx -y <pkg>@<ver>`)
 * when:
 *   - the def has no `npmPackage` (e.g. uvx- or HTTP-based MCPs)
 *   - the install hasn't happened yet (fresh boot before Category B's
 *     bundled-install step completes)
 *   - the installed version doesn't match the pinned version (drift —
 *     bundled-install will reconcile on the next run)
 *
 * The `binName` defaults to the last segment of `npmPackage`. The package's
 * `bin` field is consulted via the bin shim that npm/pnpm writes to
 * `node_modules/.bin/<binName>` at install time, so the resolver doesn't
 * need to read package.json itself.
 */
export function resolveBundledSpawn(def: BundledMcpDef): ResolvedSpawn {
  const fallback: ResolvedSpawn = {
    command: def.command,
    args: def.args ?? [],
    source: "fallback",
  };

  // In-repo MCPs (e.g. libi-tracking) ship inside the libi package itself —
  // they are NOT separate npm installs, and their DB-row fallback is
  // `npx libi serve-mcp-*`, which fails in dev because `libi` isn't on PATH
  // and is a latent security exposure in a packaged build (see below). When
  // the source tree + tsx are present, resolve the tsx-direct entry so EVERY
  // spawn path (prober, diagnose, session) launches it correctly — exactly
  // how the core libi server's tsx entry is used everywhere.
  //
  // tsx is resolved as `node_modules/tsx/dist/cli.mjs` — the ACTUAL package's
  // CLI entry point — run via `resolveNodeCommand()` (the libi-managed
  // `<LIBI_HOME>/bin/node` when present, else the bare name), NOT
  // `node_modules/.bin/tsx`.
  // electron-builder copies NO `.bin/` directories into the packaged app
  // (verified against the built bundle), so the bin shim this used to
  // resolve is always absent there even though `node_modules/tsx` itself is
  // present. Mirrors `buildLibiEntry()` in `lib/mcp-config.ts` exactly —
  // read that function's doc comment for the full rationale (including why
  // `command` is `"node"` and never `process.execPath`).
  if (def.inRepoEntry) {
    // libi's own package root, resolved by walking up from THIS module's
    // `__dirname` — NOT `process.cwd()`.
    //
    // cwd is libi's package root only in the Next.js SERVER process (a dev
    // checkout, `lib/cli/studio.ts`'s production chdir, `electron/main.ts`'s
    // chdir to the runtime root). But two of this function's three call sites
    // run in the libi MCP CHILD: `libi.diagnose_mcp`
    // (`mcp/bundled-mcps/diagnose.ts`) and the install/probe path
    // (`mcp/registry/server-prober.ts`, reached from
    // `mcp/bundled-mcps/install-tools.ts`). The ACP adapter spawns that child
    // with cwd = the AGENT WORKSPACE (`~/.libi/agent/`) — see the same note in
    // `mcp/bundled-mcps/install-tools.ts` and `mcp/registry/spawn-env.ts` —
    // which holds no `mcp/`, no `node_modules/tsx`, and no `dist-cli/`, so
    // every in-repo resolution from those paths threw the diagnostic below
    // instead of returning a spawn command.
    //
    // `packageRoot()` is depth-independent (dev tree, the compiled `dist-cli/`
    // mirror one level deeper, packaged Electron, and an installed
    // `node_modules/@nagellabs/libi/`) and falls back to `process.cwd()` only
    // under a Turbopack-bundled build, where `__dirname` is a placeholder —
    // that is exactly the Next.js server, where cwd is already correct.
    const projectRoot = packageRoot();
    // Dual mode, identical to `buildLibiEntry()`: source+tsx in dev and in the
    // packaged Electron app; the compiled `dist-cli/` twin when libi is
    // installed under node_modules, where tsx refuses to resolve `@/…` at all.
    // See lib/runtime/compiled-entry.ts.
    const resolved = resolveEntrySpawn(projectRoot, def.inRepoEntry);
    if (resolved) {
      return { command: resolved.command, args: resolved.args, source: "in-repo" };
    }
    // There is deliberately no `npx libi ...` fallback here, for the same
    // reason `buildLibiEntry()` has none: this repo is `private: true` and
    // unpublished, and the `libi` name on the public npm registry belongs to
    // an unrelated third party with no `bin` field today. `buildSpawnEnv()`
    // hands an MCP child the ENTIRE process env (`mcp/registry/spawn-env.ts`),
    // so silently shelling out to a name libi doesn't own is a latent
    // security exposure independent of whether the fallback happens to
    // "work" today. `mcp/` + `node_modules/tsx` are both guaranteed to exist
    // (dev tree, or the packaged app's `files` allowlist — electron-builder.yml
    // / package.json), so a missing entry point/tsx CLI here means a broken
    // build — fail loudly with a diagnostic instead of reaching for that
    // fallback. This function is called from the settings/ACP spawn path AND
    // from `libi.diagnose_mcp` (mcp/bundled-mcps/diagnose.ts) and the
    // install/probe path (mcp/registry/server-prober.ts), so closing the gap
    // here closes it everywhere.
    throw new Error(
      `resolveBundledSpawn: could not resolve the in-repo MCP entry point for "${def.id}" — ` +
        `${entryResolutionDiagnostic(projectRoot, def.inRepoEntry)} ` +
        `Deliberately not falling back to \`${def.command}${(def.args ?? []).length ? " " + (def.args ?? []).join(" ") : ""}\`: ` +
        `this repo is unpublished and the public \`libi\` npm package belongs to an unrelated third party.`,
    );
  }

  if (!def.npmPackage || !def.pinnedVersion) return fallback;

  const root = getLibiNodeModulesRoot();
  const binName = def.binName ?? lastSegment(def.npmPackage);
  const binPath = path.join(root, "node_modules", ".bin", binName);
  const pkgJsonPath = path.join(
    root,
    "node_modules",
    ...def.npmPackage.split("/"),
    "package.json",
  );

  let installedVersion: string | null = null;
  try {
    const raw = fs.readFileSync(pkgJsonPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "version" in parsed &&
      typeof (parsed as { version: unknown }).version === "string"
    ) {
      installedVersion = (parsed as { version: string }).version;
    }
  } catch {
    return fallback;
  }

  if (installedVersion !== def.pinnedVersion) return fallback;
  if (!fs.existsSync(binPath)) return fallback;

  return { command: binPath, args: [], source: "local" };
}

function lastSegment(npmPackage: string): string {
  const trimmed = npmPackage.startsWith("@")
    ? npmPackage.split("/").slice(1).join("/")
    : npmPackage;
  return trimmed.split("/").pop() ?? npmPackage;
}
