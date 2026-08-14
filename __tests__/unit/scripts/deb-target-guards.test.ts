import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `scripts/deb-target-guards.js` exists because the `deb` target could FAIL
// SILENTLY. A .deb is an `ar` archive of exactly three members, and fpm shells
// out to whatever `ar` is on PATH. macOS's BSD `ar -qc` refuses to append
// non-object files to an archive: it writes a 96-byte archive containing only
// a `__.SYMDEF SORTED` table, drops all three real members, prints a warning
// to stderr — and EXITS 0. fpm believed it, electron-builder believed it, and
// the build went green holding 96 bytes named `.deb`.
//
// So the guarantee is not "we found a good `ar`" (a preflight can be defeated
// by any future toolchain change); it is "bytes that are not a real deb fail
// the build". Only the postflight can promise that, and these tests are about
// the postflight above all.
//
// Every archive below is synthesised byte-by-byte rather than produced by
// running `ar`, so the tests assert the same thing on a host with GNU `ar`, a
// host with BSD `ar`, and a host with no `ar` at all — including CI.

import debGuards from "../../../scripts/deb-target-guards.js";

const { readArMemberNames, assertRealDebArchive, assertUsableAr } = debGuards as {
  readArMemberNames: (file: string) => string[] | null;
  assertRealDebArchive: (event: { file?: string }) => Promise<void>;
  assertUsableAr: (event: { targetPresentableName?: string; file?: string }) => Promise<void>;
};

const AR_MAGIC = "!<arch>\n";

/** Minimal GNU-flavoured `ar` writer — enough to build fixtures. */
function writeArArchive(file: string, members: Array<{ name: string; data: Buffer }>) {
  const chunks: Buffer[] = [Buffer.from(AR_MAGIC, "latin1")];
  for (const { name, data } of members) {
    const header =
      `${name}/`.padEnd(16) + // GNU short-name terminator
      "0".padEnd(12) + // mtime
      "0".padEnd(6) + // uid
      "0".padEnd(6) + // gid
      "100644".padEnd(8) + // mode
      String(data.length).padEnd(10) + // size
      "`\n";
    chunks.push(Buffer.from(header, "latin1"), data);
    if (data.length % 2 === 1) chunks.push(Buffer.from("\n", "latin1"));
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

/**
 * The exact shape BSD `ar` leaves behind: the archive magic plus a lone
 * `__.SYMDEF SORTED` member, using the BSD `#1/<len>` extended-name encoding
 * that stores the name in the front of the member data.
 */
function writeBsdSymdefStub(file: string) {
  const name = "__.SYMDEF SORTED";
  const payload = Buffer.concat([Buffer.from(name, "latin1"), Buffer.alloc(12)]);
  const header =
    `#1/${name.length}`.padEnd(16) +
    "1785332856".padEnd(12) +
    "501".padEnd(6) +
    "20".padEnd(6) +
    "100644".padEnd(8) +
    String(payload.length).padEnd(10) +
    "`\n";
  fs.writeFileSync(
    file,
    Buffer.concat([Buffer.from(AR_MAGIC + header, "latin1"), payload]),
  );
}

const tempDirs: string[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-deb-guard-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

function validDeb(dir: string, name = "libi_0.1.0_amd64.deb") {
  const file = path.join(dir, name);
  writeArArchive(file, [
    { name: "debian-binary", data: Buffer.from("2.0\n") },
    { name: "control.tar.xz", data: Buffer.alloc(128, 1) },
    { name: "data.tar.xz", data: Buffer.alloc(4096, 2) },
  ]);
  return file;
}

describe("readArMemberNames", () => {
  it("reads every member of a well-formed archive, in order", () => {
    expect(readArMemberNames(validDeb(tempDir()))).toEqual([
      "debian-binary",
      "control.tar.xz",
      "data.tar.xz",
    ]);
  });

  it("decodes BSD `#1/<len>` extended names — the encoding the corrupt stub uses", () => {
    const file = path.join(tempDir(), "stub.deb");
    writeBsdSymdefStub(file);
    expect(readArMemberNames(file)).toEqual(["__.SYMDEF SORTED"]);
  });

  it("returns null for a file that is not an ar archive at all", () => {
    const file = path.join(tempDir(), "not-an-archive.deb");
    fs.writeFileSync(file, "this is not a deb");
    expect(readArMemberNames(file)).toBeNull();
  });
});

describe("assertRealDebArchive (the postflight — the actual guarantee)", () => {
  it("passes a real three-member deb", async () => {
    await expect(assertRealDebArchive({ file: validDeb(tempDir()) })).resolves.toBeUndefined();
  });

  it("REJECTS the 96-byte BSD `__.SYMDEF` stub that fpm produces with exit 0", async () => {
    const file = path.join(tempDir(), "libi_0.1.0_amd64.deb");
    writeBsdSymdefStub(file);
    await expect(assertRealDebArchive({ file })).rejects.toThrow(/not a valid Debian package/);
  });

  it("deletes the corrupt artifact as well as failing, so it cannot be uploaded by mistake", async () => {
    const file = path.join(tempDir(), "libi_0.1.0_amd64.deb");
    writeBsdSymdefStub(file);
    await expect(assertRealDebArchive({ file })).rejects.toThrow();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("rejects a deb whose members are present but in the wrong order (debian-binary must be first)", async () => {
    const file = path.join(tempDir(), "libi_0.1.0_amd64.deb");
    writeArArchive(file, [
      { name: "control.tar.xz", data: Buffer.alloc(128, 1) },
      { name: "debian-binary", data: Buffer.from("2.0\n") },
      { name: "data.tar.xz", data: Buffer.alloc(64, 2) },
    ]);
    await expect(assertRealDebArchive({ file })).rejects.toThrow(/must be `debian-binary`/);
  });

  it("accepts any tarball compression suffix (deb_compression is configurable)", async () => {
    const file = path.join(tempDir(), "libi_0.1.0_amd64.deb");
    writeArArchive(file, [
      { name: "debian-binary", data: Buffer.from("2.0\n") },
      { name: "control.tar.gz", data: Buffer.alloc(128, 1) },
      { name: "data.tar.zst", data: Buffer.alloc(64, 2) },
    ]);
    await expect(assertRealDebArchive({ file })).resolves.toBeUndefined();
  });

  it("ignores every non-deb artifact — dmg, zip, exe and AppImage all pass through", async () => {
    for (const name of ["Libi-0.1.0.dmg", "Libi.zip", "Libi Setup.exe", "Libi-0.1.0.AppImage"]) {
      await expect(
        assertRealDebArchive({ file: path.join(tempDir(), name) }),
      ).resolves.toBeUndefined();
    }
  });
});

describe("assertUsableAr (the preflight)", () => {
  it("no-ops for non-deb artifacts rather than probing `ar` on every build", async () => {
    const pathBefore = process.env.PATH;
    await expect(
      assertUsableAr({ targetPresentableName: "dmg", file: "/tmp/Libi-0.1.0.dmg" }),
    ).resolves.toBeUndefined();
    expect(process.env.PATH).toBe(pathBefore);
  });

  it("fails with actionable instructions when the only candidate cannot write a real archive", async () => {
    const previous = process.env.LIBI_DEB_AR;
    // `true(1)` exits 0 and writes nothing — the same "success, no archive"
    // shape as BSD `ar`, without depending on which `ar` this host has.
    process.env.LIBI_DEB_AR = "/usr/bin/true";
    try {
      await expect(
        assertUsableAr({ targetPresentableName: "deb", file: "/tmp/libi_0.1.0_amd64.deb" }),
      ).rejects.toThrow(/no usable `ar`/);
    } finally {
      if (previous === undefined) delete process.env.LIBI_DEB_AR;
      else process.env.LIBI_DEB_AR = previous;
    }
  });
});
