/**
 * electron-builder hooks that make the `deb` target either correct or absent —
 * never silently corrupt.
 *
 * Two named exports, wired to two config keys in `electron-builder.yml`
 * (`resolveFunction` in app-builder-lib picks the export matching the key, so
 * one module can serve both):
 *
 *   artifactBuildStarted   → `assertUsableAr`     (preflight, before fpm runs)
 *   artifactBuildCompleted → `assertRealDebArchive` (postflight, on the bytes)
 *
 * ## The defect these exist for
 *
 * A `.deb` is an `ar` archive with exactly three members, in order:
 * `debian-binary`, `control.tar.*`, `data.tar.*`. fpm builds the two tarballs
 * itself and then shells out to whatever `ar` it finds on PATH
 * (`fpm/util.rb#ar_cmd` → `fpm/package/deb.rb#output`).
 *
 * On macOS that is BSD `ar`, and BSD `ar -qc` does not append members to a
 * non-object archive — it writes a 96-byte archive containing only a
 * `__.SYMDEF SORTED` table, drops all three real members, prints a *warning*,
 * and EXITS 0. fpm's `safesystem` sees success, electron-builder sees success,
 * and the build finishes green with a 96-byte file named `.deb`. Measured
 * directly on this repo's toolchain:
 *
 *     $ /usr/bin/ar -qc out.deb debian-binary control.tar.xz data.tar.xz
 *     ranlib: warning: archive member 'debian-binary' not a mach-o file
 *     $ echo $?   → 0
 *     $ ls -l out.deb   → 96 bytes
 *     $ ar -t out.deb   → __.SYMDEF SORTED
 *
 * electron-builder does not close this: its macOS helper toolchain
 * (`linux-tools-mac-10.12.3`, prepended to PATH for non-rpm fpm targets)
 * ships only `gnu-tar` and `lzip` — no `ar`. So a GNU `ar` has to come from
 * the host, and on a stock macOS there isn't one.
 *
 * ## Why a preflight AND a postflight
 *
 * The preflight makes the build WORK wherever a GNU `ar` can be found, and
 * fail loudly with instructions where it can't. The postflight is the actual
 * guarantee: it reads the produced bytes and refuses anything that is not a
 * real three-member `deb`, so even a future toolchain change that defeats the
 * preflight cannot ship a stub. The invariant is "a broken deb fails the
 * build", and only the postflight can promise that.
 *
 * ## Why the preflight installs a shim instead of just checking
 *
 * fpm picks its own `ar` by probing `ar` then `gar`, each with `-qc` then
 * `-qcD`, and accepting the first combination whose `-tv` output shows
 * `0/0 ... 1970` (i.e. deterministic). If none qualifies it falls back to a
 * bare `ar -qc` — the BSD one, the corrupting one. That probe tests
 * DETERMINISM, not correctness, so agreeing with it is not enough: an old GNU
 * `ar` that fails the determinism probe still writes a perfectly good archive,
 * and fpm would then fall back to BSD `ar` anyway.
 *
 * So instead of predicting fpm's choice we constrain it: a temp directory
 * containing a single `ar` symlink to a verified-good binary is prepended to
 * PATH. Whichever branch fpm's probe takes, the `ar` it resolves is ours. A
 * one-entry shim rather than the whole binutils `bin/` keeps `strip`, `nm`,
 * `objcopy` and friends from shadowing the host toolchain for the rest of the
 * build.
 *
 * PATH is mutated on `process.env` because `FpmTarget#build` snapshots
 * `{...process.env}` for the fpm child AFTER `artifactBuildStarted` has been
 * awaited. electron-builder prepends its own `linux-tools` bin ahead of ours
 * in that same snapshot, which is what we want — its `gnu-tar` must keep
 * winning over the shim's directory.
 *
 * Correctness is decided by writing a real three-member archive with the
 * candidate and parsing it back, not by matching a version string. That tests
 * the exact behaviour that breaks.
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

/** Set to an absolute path to force a specific `ar`, skipping discovery. */
const AR_OVERRIDE_ENV = "LIBI_DEB_AR";

/**
 * Directories searched after PATH. Homebrew's `binutils` is keg-only — it is
 * deliberately NOT linked into PATH — so a macOS host that has a perfectly
 * good GNU `ar` still resolves the BSD one for every bare `ar` call.
 */
const EXTRA_AR_DIRS = [
  "/opt/homebrew/opt/binutils/bin",
  "/usr/local/opt/binutils/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
];

const AR_MAGIC = "!<arch>\n";

/**
 * Member names of an `ar` archive, read from the bytes rather than by shelling
 * out to `ar -t` — the tool under suspicion is not a trustworthy witness to its
 * own output, and this must also work on a host with no usable `ar` at all.
 *
 * Handles both extended-name conventions: BSD stores the name in the first
 * `len` bytes of the member data behind a `#1/<len>` marker; GNU pads short
 * names with a trailing `/`.
 */
function readArMemberNames(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.length < AR_MAGIC.length || buf.toString("latin1", 0, AR_MAGIC.length) !== AR_MAGIC) {
    return null; // not an ar archive at all
  }

  const names = [];
  let offset = AR_MAGIC.length;

  while (offset + 60 <= buf.length) {
    const header = buf.toString("latin1", offset, offset + 60);
    if (header.slice(58, 60) !== "`\n") {
      return null; // header magic wrong — truncated or malformed
    }

    const size = Number.parseInt(header.slice(48, 58).trim(), 10);
    if (!Number.isFinite(size) || size < 0) {
      return null;
    }

    let name = header.slice(0, 16).trim();
    const dataStart = offset + 60;

    const bsdExtended = /^#1\/(\d+)$/.exec(name);
    if (bsdExtended) {
      const nameLen = Number.parseInt(bsdExtended[1], 10);
      name = buf.toString("latin1", dataStart, dataStart + nameLen).replace(/\0+$/, "");
    } else if (name.endsWith("/") && name !== "/" && name !== "//") {
      name = name.slice(0, -1); // GNU short-name terminator
    }

    names.push(name);
    offset = dataStart + size + (size % 2); // members are 2-byte aligned
  }

  return names;
}

/**
 * True when `arPath` can append three ordinary (non-object) files to a fresh
 * archive and have all three come back out. This is precisely what BSD `ar`
 * fails at while reporting success.
 */
function writesRealArchive(arPath) {
  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ar-probe-"));
    const members = ["debian-binary", "control.tar.xz", "data.tar.xz"];
    for (const [i, member] of members.entries()) {
      fs.writeFileSync(path.join(dir, member), Buffer.alloc(64 * (i + 1), i + 1));
    }

    execFileSync(arPath, ["-qc", "probe.a", ...members], {
      cwd: dir,
      stdio: "ignore",
      timeout: 30_000,
    });

    const found = readArMemberNames(path.join(dir, "probe.a"));
    return found != null && members.every((m) => found.includes(m));
  } catch {
    return false;
  } finally {
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Absolute candidate paths, in preference order: PATH first, then the extras. */
function candidateArPaths() {
  const seen = new Set();
  const candidates = [];

  const push = (candidate) => {
    if (!candidate) return;
    let resolved;
    try {
      resolved = fs.realpathSync(candidate);
    } catch {
      return;
    }
    if (seen.has(resolved)) return;
    seen.add(resolved);
    candidates.push(candidate);
  };

  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  // `ar` before `gar` within each directory, mirroring fpm's own preference.
  for (const dir of [...pathDirs, ...EXTRA_AR_DIRS]) {
    push(path.join(dir, "ar"));
    push(path.join(dir, "gar"));
  }

  return candidates;
}

function failWithInstructions(target) {
  throw new Error(
    [
      `[deb-guard] Refusing to build ${target}: no usable \`ar\` on this host.`,
      "",
      "A .deb is an `ar` archive, and fpm shells out to the `ar` it finds on PATH.",
      "macOS ships BSD `ar`, which silently writes a 96-byte `__.SYMDEF` stub",
      "instead of the package AND EXITS 0 — so without this check the build would",
      "report success and hand you a corrupt artifact. GNU `ar` is required.",
      "",
      "Fix it one of these ways:",
      "  • macOS:  brew install binutils      (keg-only; this guard finds it anyway)",
      "  • set     LIBI_DEB_AR=/absolute/path/to/gnu-ar",
      "  • build the deb on a Linux host, where `ar` is GNU already",
      "",
      "Or drop `deb` from `linux.target` in electron-builder.yml — the AppImage",
      "target has no such host requirement.",
    ].join("\n"),
  );
}

/**
 * `artifactBuildStarted` — runs immediately before `FpmTarget` invokes fpm.
 * No-ops for every non-deb artifact.
 */
async function assertUsableAr(event) {
  const target = event && (event.targetPresentableName || event.file);
  const isDeb =
    (event && event.targetPresentableName === "deb") ||
    (event && typeof event.file === "string" && event.file.endsWith(".deb"));
  if (!isDeb) {
    return;
  }

  const override = process.env[AR_OVERRIDE_ENV];
  const candidates = override ? [override] : candidateArPaths();

  const chosen = candidates.find((candidate) => writesRealArchive(candidate));
  if (!chosen) {
    failWithInstructions(target);
  }

  // Constrain fpm's choice rather than predicting it — see the header.
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ar-shim-"));
  fs.symlinkSync(fs.realpathSync(chosen), path.join(shimDir, "ar"));
  process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH || ""}`;

  process.stdout.write(`[deb-guard] using GNU ar at ${chosen} (shimmed onto PATH)\n`);
}

/**
 * `artifactBuildCompleted` — the actual guarantee. Reads the produced bytes and
 * refuses anything that is not a real three-member `deb`. No-ops for every
 * non-deb artifact.
 */
async function assertRealDebArchive(event) {
  const file = event && event.file;
  if (typeof file !== "string" || !file.endsWith(".deb")) {
    return;
  }

  const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const names = readArMemberNames(file);

  const problem = (() => {
    if (names == null) return "not an `ar` archive";
    if (names.length !== 3) return `expected 3 members, found ${names.length}: ${names.join(", ")}`;
    if (names[0] !== "debian-binary") return `first member is \`${names[0]}\`, must be \`debian-binary\``;
    if (!/^control\.tar(\.[a-z0-9]+)?$/.test(names[1])) return `second member is \`${names[1]}\`, must be \`control.tar*\``;
    if (!/^data\.tar(\.[a-z0-9]+)?$/.test(names[2])) return `third member is \`${names[2]}\`, must be \`data.tar*\``;
    return null;
  })();

  if (problem) {
    // Remove it as well as failing. A file named `.deb` sitting in `release/`
    // after a failed build is exactly the thing someone uploads by mistake.
    try {
      fs.rmSync(file, { force: true });
    } catch {
      /* the throw below is the contract; deletion is a courtesy */
    }
    throw new Error(
      [
        `[deb-guard] ${path.basename(file)} is not a valid Debian package: ${problem}.`,
        `  size: ${size} bytes`,
        names ? `  members: ${names.join(", ") || "(none)"}` : "  members: (unreadable)",
        "",
        "This is the BSD-`ar` corruption described in scripts/deb-target-guards.js:",
        "fpm exits 0 having written a `__.SYMDEF` stub. Failing the build instead.",
      ].join("\n"),
    );
  }

  process.stdout.write(
    `[deb-guard] OK — ${path.basename(file)} is a valid deb ` +
      `(${names.join(" + ")}, ${(size / 1024 / 1024).toFixed(1)} MB)\n`,
  );
}

module.exports = {
  artifactBuildStarted: assertUsableAr,
  artifactBuildCompleted: assertRealDebArchive,
  // Exported under their own names for unit tests.
  assertUsableAr,
  assertRealDebArchive,
  readArMemberNames,
  writesRealArchive,
};
