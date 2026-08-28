// lib/install/next-externals.ts
//
// Turbopack's production build emits `next.config.ts#serverExternalPackages`
// under HASHED request names and makes them resolvable at runtime via a
// symlink farm at `.next/node_modules/` (see the long comment in
// electron-builder.yml — this is the exact mechanism that once made a
// packaged Electron app 500 on every route until that directory was added
// to its `files` allowlist).
//
// `npm pack` / `npm publish` strip ALL symlinks from the tarball
// unconditionally (verified empirically — no `files` glob, negation, or
// directory name can prevent it; npm's tar step simply never writes a
// symlink entry). So a consumer's installed copy of `.next/node_modules`
// arrives empty. `scripts/write-next-externals-manifest.js` records the
// (small, currently ~8-entry) symlink farm as a plain JSON manifest at
// build time — ordinary file content, so it survives packing — and
// `ensureNextExternalSymlinks` (below) recreates the real symlinks from it
// at production-boot time (`lib/cli/studio.ts`).
//
// The manifest deliberately does NOT record the original symlinks' relative
// target strings (e.g. `../../node_modules/pino`) — those are calibrated
// for `.next` sitting at a project root that ALSO directly contains
// `node_modules` (true for a dev checkout, and true for the build machine
// that ran `next build`), but FALSE the moment this package is installed
// AS A DEPENDENCY: `.next` then lives at `node_modules/libi/.next/`, one
// level deeper than the build machine's layout, while npm hoists `pino`
// et al. to the CONSUMER's top-level `node_modules/` — not nested under
// `node_modules/libi/node_modules/`, which the baked-in relative math
// assumes. (Verified the hard way: recreating the exact recorded relative
// targets produces symlinks that resolve to a `node_modules/libi/node_modules/`
// path that doesn't exist — dangling links, `Cannot find module
// '@opentelemetry/instrumentation-<hash>'` — even though the manifest read
// back and the symlinks appeared to "exist" via a bare `fs.lstatSync`.)
// The manifest instead records the bare PACKAGE SPECIFIER
// (`"pino"`, `"@napi-rs/canvas"`), and `findPackageDir` walks UP from
// wherever `.next` actually ended up at runtime — the dependency-free
// equivalent of Node's own ancestor `node_modules` search — so the symlink
// always targets whatever copy the CONSUMER's own `npm install` actually
// produced, at whatever depth it landed.
//
// ── EVERY failure here is LOUD ────────────────────────────────────────────
// The first cut of this module treated an absent manifest as "nothing to
// restore" and a `missing` package as a warning-and-continue. Both are
// indistinguishable, at boot, from a perfectly healthy start — and both end
// with a server that binds its port and returns HTTP 500 for EVERY route,
// which is the single worst failure shape available (a user cannot tell it
// from a bug in the app). The three ways this can go wrong are therefore
// all hard `NextExternalsError` throws:
//
//   1. `MANIFEST_MISSING`  — the build never ran the writer (the exact
//      outcome of a release built via a path that forgot to chain it).
//   2. `MANIFEST_STALE`    — the manifest's `buildId` doesn't match
//      `.next/BUILD_ID`, i.e. it describes a PREVIOUS build's hashed names.
//      Checked empirically (planted a stray file at `.next` root before a
//      release build): `next build` DOES clear it, so a normal full rebuild
//      can't leave a stale manifest behind — the common bad path is a
//      MISSING manifest (build-script wiring didn't chain the writer),
//      covered by case 1, which the deletion actually guarantees. This
//      check is defense-in-depth for the cases the deletion doesn't cover —
//      an interrupted/partial build, a hand-copied or restored `.next`, or a
//      future Next version that stops clearing — so a stale manifest can
//      never silently restore symlinks under a previous build's hashes.
//   3. `PACKAGES_MISSING`  — a recorded external isn't installed anywhere
//      up the ancestor chain (a hoisting outcome that nested it under a
//      sibling package's own `node_modules/`, or a pruned install).
//
// The one legitimate no-op is a `.next` whose symlink farm is ALREADY
// present and resolvable — a dev checkout, where Turbopack's own farm was
// never packed away. That is detected on disk (`farmHasResolvableEntries`),
// never assumed.
//
// ── WHO CALLS THIS, AND WHEN ──────────────────────────────────────────────
// Three callers, and only one of them is ever expected to WRITE:
//
//   * `scripts/build-runtime-bundle.js` — right after the bundle's `npm
//     install`, against `build/libi-bundle/…/.next`. This is the write that
//     matters: it materialises the farm so the copy that lands in
//     `Libi.app/Contents/Resources/` already has it.
//   * `lib/runtime/runtime-install.ts` — same, for a runtime FETCHED into
//     `<LIBI_HOME>/runtime/<version>/`.
//   * `lib/server/next-server.ts` / `lib/cli/studio.ts` — at boot. For a
//     packaged or fetched runtime this is a pure verify (every entry takes
//     the `verified` branch, nothing is written). It still genuinely writes
//     for a plain `npx`/`npm i` consumer, whose `node_modules` is writable
//     and whose install npm stripped the symlinks out of.
//
// Boot MUST NOT be the first writer for a packaged app: `.app` contents are
// code-signed and may sit on a read-only mount, so writing there is a
// signature break in the good case and an EROFS crash in the bad one. That
// is why the created links are RELATIVE — see `ensureNextExternalSymlinks`.
import fs from "node:fs";
import path from "node:path";

import { isWindows } from "@/lib/platform";

export interface ExternalSymlinkEntry {
  /** Path of the symlink, relative to `.next/node_modules/`. */
  link: string;
  /** Bare package specifier the symlink must resolve to, e.g. "pino" or
   *  "@napi-rs/canvas" — never a pre-computed relative path (see module
   *  doc for why that doesn't survive a different install depth). */
  package: string;
}

export interface ExternalsManifest {
  /** The `.next/BUILD_ID` of the build that produced these hashed names.
   *  Turbopack's hashes change between builds, so a manifest is only valid
   *  for the exact `.next` it was written alongside. */
  buildId: string;
  links: ExternalSymlinkEntry[];
}

export type NextExternalsErrorCode =
  | "MANIFEST_MISSING"
  | "MANIFEST_STALE"
  | "PACKAGES_MISSING";

export class NextExternalsError extends Error {
  readonly code: NextExternalsErrorCode;
  constructor(code: NextExternalsErrorCode, message: string) {
    super(message);
    this.name = "NextExternalsError";
    this.code = code;
  }
}

export const EXTERNALS_MANIFEST_FILENAME = "externals-manifest.json";

/** Read + validate `.next/externals-manifest.json`. Returns `null` when the
 *  file is absent, unparsable, or not in the `{ buildId, links }` shape —
 *  callers MUST treat that as a hard failure unless the symlink farm is
 *  already present on disk (see `ensureNextExternalSymlinks`). */
export function readExternalsManifest(nextDir: string): ExternalsManifest | null {
  const manifestPath = path.join(nextDir, EXTERNALS_MANIFEST_FILENAME);
  try {
    const raw = fs.readFileSync(manifestPath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const { buildId, links } = parsed as { buildId?: unknown; links?: unknown };
    if (typeof buildId !== "string" || buildId.length === 0) return null;
    if (!Array.isArray(links)) return null;
    return {
      buildId,
      links: links.filter(
        (e): e is ExternalSymlinkEntry =>
          !!e && typeof e.link === "string" && typeof e.package === "string",
      ),
    };
  } catch {
    return null;
  }
}

/** `.next/BUILD_ID`, or null when absent/unreadable (which, for a `.next`
 *  that `next({ dev: false })` is about to be pointed at, already means
 *  "not a production build"). */
export function readBuildId(nextDir: string): string | null {
  try {
    const id = fs.readFileSync(path.join(nextDir, "BUILD_ID"), "utf-8").trim();
    return id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/** Walk up from `startDir` through ancestor directories looking for
 *  `node_modules/<pkg>`, exactly like Node's own module resolution would
 *  from a file at `startDir`. Deliberately NOT `require.resolve` (which
 *  would need every dependency to explicitly list `"./package.json"` in
 *  its `exports` map to be resolvable this way — not all do; tsx happens
 *  to, but that's not a guarantee this can lean on for every external). */
export function findPackageDir(startDir: string, pkg: string): string | null {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 64; i++) {
    const candidate = path.join(dir, "node_modules", pkg);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** True when `.next/node_modules` already holds at least one symlink whose
 *  target actually resolves — the dev-checkout / packaged-Electron case,
 *  where Turbopack's own farm survived intact and there is nothing to
 *  restore. Uses `realpathSync` (not `lstatSync`) deliberately: a DANGLING
 *  symlink passes an lstat-only check and was the original false positive
 *  that hid this whole bug class. */
export function farmHasResolvableEntries(nodeModulesDir: string): boolean {
  // Scrupulous about partial state, like every other check in this module:
  // this used to return `true` on the FIRST resolvable symlink it found,
  // so a partially-broken farm (e.g. 1 of 8 entries resolving, the other 7
  // dangling) was accepted as "farm-already-present" — the exact silent
  // no-op class this module otherwise refuses. Walk the WHOLE tree and
  // require every symlink found to resolve; a farm with even one dangling
  // entry is not trustworthy enough to skip rebuilding from the manifest.
  let sawSymlink = false;
  let allResolvable = true;

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        sawSymlink = true;
        try {
          fs.realpathSync(full);
        } catch {
          allResolvable = false; // dangling — the whole farm is untrusted
        }
      } else if (entry.isDirectory()) {
        // Scoped packages (`@napi-rs/canvas-<hash>`) nest one level.
        walk(full);
      }
    }
  }

  walk(nodeModulesDir);
  return sawSymlink && allResolvable;
}

export interface EnsureResult {
  /** Entries that were (re)created because they were missing or wrong. */
  created: ExternalSymlinkEntry[];
  /** Entries that already pointed at the right package — left untouched. */
  verified: ExternalSymlinkEntry[];
  /** Set when nothing was done, with the (legitimate) reason:
   *  - `farm-already-present`: an unstamped build whose real symlink farm is
   *    intact on disk (dev checkout / packaged Electron).
   *  - `no-externals`: a valid, current manifest that records zero externals. */
  skipped?: "farm-already-present" | "no-externals";
}

function reinstallHint(nextDir: string): string {
  return (
    `Rebuild with \`npm run build\` (or \`node scripts/next-build-release.js\`), ` +
    `which writes ${path.join(".next", EXTERNALS_MANIFEST_FILENAME)} as part of the build; ` +
    `if you installed this from npm, reinstall the package (the published tarball always ` +
    `carries the manifest). Checked: ${nextDir}`
  );
}

/**
 * Recreate `.next/node_modules`'s externals symlink farm from the recorded
 * manifest, resolving each target FRESH against the CURRENT install (never
 * a relative path baked in at build time — see module doc). Idempotent:
 * an existing symlink that already resolves (via `realpathSync`) to the
 * correct target is left untouched. Safe to call on every production boot:
 * cheap (a handful of entries) and self-heals a `node_modules` that was
 * pruned/reinstalled since the last boot.
 *
 * THROWS `NextExternalsError` on every condition that would otherwise
 * produce a port-bound, 500-on-every-route server. See the module doc.
 */
export function ensureNextExternalSymlinks(nextDir: string): EnsureResult {
  const nodeModulesDir = path.join(nextDir, "node_modules");
  const manifest = readExternalsManifest(nextDir);

  if (!manifest) {
    // The only benign reading of "no manifest": the farm Turbopack itself
    // built is right there on disk and resolves. Anything else is a build
    // that never ran the writer — fail now, loudly, instead of at the
    // first request.
    if (farmHasResolvableEntries(nodeModulesDir)) {
      return { created: [], verified: [], skipped: "farm-already-present" };
    }
    throw new NextExternalsError(
      "MANIFEST_MISSING",
      `Next.js externals manifest is missing or unreadable and .next/node_modules holds no ` +
        `usable symlinks. Turbopack externalises packages under hashed names that resolve ` +
        `only through that symlink farm, so the server would start and then fail EVERY ` +
        `request with a 500. ${reinstallHint(nextDir)}`,
    );
  }

  const buildId = readBuildId(nextDir);
  if (buildId === null) {
    throw new NextExternalsError(
      "MANIFEST_STALE",
      `Next.js externals manifest found, but .next/BUILD_ID is missing — this is not a ` +
        `complete production build, so the manifest cannot be verified against it. ` +
        `${reinstallHint(nextDir)}`,
    );
  }
  if (buildId !== manifest.buildId) {
    throw new NextExternalsError(
      "MANIFEST_STALE",
      `Next.js externals manifest is STALE: it was written for build ` +
        `"${manifest.buildId}" but .next/BUILD_ID is "${buildId}". Turbopack's hashed ` +
        `external names change between builds, so restoring from it would create symlinks ` +
        `under the previous build's names and every request would 500. ` +
        `${reinstallHint(nextDir)}`,
    );
  }

  if (manifest.links.length === 0) {
    return { created: [], verified: [], skipped: "no-externals" };
  }

  const result: EnsureResult = { created: [], verified: [] };
  const missing: ExternalSymlinkEntry[] = [];

  for (const entry of manifest.links) {
    const targetDir = findPackageDir(nextDir, entry.package);
    if (!targetDir) {
      missing.push(entry);
      continue;
    }

    const linkPath = path.join(nodeModulesDir, entry.link);
    try {
      const stat = fs.lstatSync(linkPath);
      if (stat.isSymbolicLink() && fs.realpathSync(linkPath) === fs.realpathSync(targetDir)) {
        result.verified.push(entry);
        continue; // already correct — no-op
      }
      fs.rmSync(linkPath, { force: true, recursive: true });
    } catch {
      /* doesn't exist yet — fall through to create it */
    }
    const linkDir = path.dirname(linkPath);
    fs.mkdirSync(linkDir, { recursive: true });
    // RELATIVE target, computed fresh from two already-resolved absolute
    // paths — never the relative string recorded at build time (that was
    // the original bug; see the module doc). `path.relative` does the
    // depth math exactly, so this carries none of the risk that made the
    // baked-in strings wrong.
    //
    // Relative rather than absolute because the tree gets MOVED after
    // these are written. The runtime bundle is materialised at
    // `build/libi-bundle/` and then copied into
    // `Libi.app/Contents/Resources/libi-bundle/`; an absolute link written
    // during the build points at the build machine's checkout and dangles
    // on the user's disk. Writing them relative is what lets the farm be
    // created ONCE at bundle-build time — which is the whole point, because
    // the alternative is creating them at first boot INSIDE the signed
    // `.app`, i.e. a code-signature break, and an outright EROFS failure on
    // any read-only mount. With relative links, a packaged boot only ever
    // lstat/realpath-verifies them (the `verified` branch above) and writes
    // nothing.
    //
    // The explicit `"dir"` type is a Windows requirement, not decoration:
    // without it Node autodetects the target kind, and for a RELATIVE
    // target it resolves that probe against `process.cwd()` rather than
    // against the link's own directory — so it guesses "file" and produces
    // a symlink Windows won't traverse as a directory.
    //
    // ...except that on Windows a `"dir"` symlink is a PRIVILEGED operation.
    // Creating one needs SeCreateSymbolicLinkPrivilege, which an ordinary
    // account does not hold and which UAC strips from an administrator's
    // token unless Developer Mode is on. A JUNCTION is the unprivileged
    // equivalent for directory targets and is what Windows gets instead.
    //
    // This is not a hypothetical. NSIS does not store symlinks, so unlike the
    // signed `.app` — where the farm survives packaging and boot only
    // verifies it — the Windows install arrives with NO farm and MUST build
    // one at first boot. On v0.1.8 that meant libi did not start at all for a
    // normal Windows user: `mkdirSync` succeeded, this line threw EPERM
    // ("Administrator privilege required"), and the shell died between
    // "about to startNextServer" and any further log line — a splash screen
    // that never resolves and nothing to explain it. It reached QA green only
    // because the QA box runs an ELEVATED administrator, which is precisely
    // the privilege a real user lacks. Verified on that box under a
    // trustlevel-0x20000 token: the `"dir"` symlink is refused and the
    // junction is created, side by side.
    //
    // Junctions take an ABSOLUTE target (Node resolves the argument to one
    // regardless), which costs nothing here: the only Windows farm that is
    // ever USED is the one built in place at boot, in its final location.
    // A farm baked at build time is stripped by NSIS before it can be moved
    // anywhere, so there is no relocation for an absolute target to survive.
    // `isWindows()` and not `process.platform === "win32"`: Turbopack folds
    // that comparison against the BUILD machine and drops the dead branch, so
    // a macOS-built runtime would ship a Windows shell that still takes the
    // symlink path — the exact fix, deleted by the compiler. See lib/platform.ts.
    if (isWindows()) {
      fs.symlinkSync(targetDir, linkPath, "junction");
    } else {
      fs.symlinkSync(path.relative(linkDir, targetDir), linkPath, "dir");
    }
    result.created.push(entry);
  }

  if (missing.length > 0) {
    // These are real `dependencies` of this package (see package.json — the
    // two OpenTelemetry-adjacent ones are declared DIRECTLY precisely so npm
    // hoists them next to everything else instead of nesting them under
    // @sentry/node's own node_modules, where the ancestor walk can't see
    // them). Not finding one means the install is broken, and every route
    // that touches it would 500.
    throw new NextExternalsError(
      "PACKAGES_MISSING",
      `Could not locate ${missing.length} externalised package(s) in any ancestor ` +
        `node_modules: ${missing.map((m) => m.package).join(", ")}. The server would start ` +
        `and then fail requests that touch them. Reinstall dependencies ` +
        `(\`npm install\`) and try again. Searched upward from: ${nextDir}`,
    );
  }

  return result;
}
