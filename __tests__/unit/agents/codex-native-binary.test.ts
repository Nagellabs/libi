import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  codexNativeBinaryCandidates,
  codexNativeBinaryMissingError,
  codexNativeBinaryPresent,
  codexPlatformPackageName,
  codexTargetTriple,
  resolveCodexNativeBinary,
} from "@/lib/agents/codex-native-binary";

/**
 * These assert the resolution logic against the launcher's own lookup
 * (`node_modules/@openai/codex/bin/codex.js`) — if libi's availability check
 * and the launcher disagree about where the engine binary lives, the check
 * either blesses a tree the launcher can't use or condemns one that works.
 *
 * MIGRATION (2026-08-02): `@zed-industries/codex-acp` is deprecated in favour
 * of `@agentclientprotocol/codex-acp`. That moved the engine from
 * `@zed-industries/codex-acp-<platform>-<arch>/bin/codex-acp` to
 * `@openai/codex-<platform>-<arch>/vendor/<rust-triple>/bin/codex`. BOTH the
 * package name and the path shape changed, and the triple is not derivable
 * from platform-arch by string munging (linux uses *musl* triples), so the
 * mapping is pinned here explicitly.
 */

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "libi-codex-"));
  roots.push(root);
  return root;
}

/** Seed an engine binary at the launcher's real path shape. */
function seedBinary(
  root: string,
  pkg: string,
  triple: string,
  file = "codex",
): string {
  const full = path.join(
    root,
    "node_modules",
    ...pkg.split("/"),
    "vendor",
    triple,
    "bin",
    file,
  );
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, "#!/bin/sh\n");
  chmodSync(full, 0o755);
  return full;
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("codexTargetTriple", () => {
  it("mirrors the launcher's mapping exactly — linux is MUSL", () => {
    // Copied from PLATFORM_PACKAGE_BY_TARGET in @openai/codex/bin/codex.js.
    // A gnu triple here would build a path that never exists, and Codex would
    // report "not installed" forever on Linux.
    expect(codexTargetTriple({ platform: "linux", arch: "x64" })).toBe(
      "x86_64-unknown-linux-musl",
    );
    expect(codexTargetTriple({ platform: "linux", arch: "arm64" })).toBe(
      "aarch64-unknown-linux-musl",
    );
    expect(codexTargetTriple({ platform: "darwin", arch: "x64" })).toBe(
      "x86_64-apple-darwin",
    );
    expect(codexTargetTriple({ platform: "darwin", arch: "arm64" })).toBe(
      "aarch64-apple-darwin",
    );
    expect(codexTargetTriple({ platform: "win32", arch: "x64" })).toBe(
      "x86_64-pc-windows-msvc",
    );
    expect(codexTargetTriple({ platform: "win32", arch: "arm64" })).toBe(
      "aarch64-pc-windows-msvc",
    );
  });

  it("treats android as linux, like the launcher does", () => {
    expect(codexTargetTriple({ platform: "android", arch: "arm64" })).toBe(
      "aarch64-unknown-linux-musl",
    );
  });

  it("returns null on an unsupported host instead of a bogus path", () => {
    expect(codexTargetTriple({ platform: "freebsd", arch: "x64" })).toBeNull();
    expect(codexTargetTriple({ platform: "darwin", arch: "ia32" })).toBeNull();
    expect(codexNativeBinaryCandidates("/root", { platform: "freebsd", arch: "x64" })).toEqual(
      [],
    );
  });
});

describe("codexPlatformPackageName", () => {
  it("names @openai/codex-<platform>-<arch> for every supported target", () => {
    expect(codexPlatformPackageName({ platform: "darwin", arch: "arm64" })).toBe(
      "@openai/codex-darwin-arm64",
    );
    expect(codexPlatformPackageName({ platform: "linux", arch: "x64" })).toBe(
      "@openai/codex-linux-x64",
    );
    expect(codexPlatformPackageName({ platform: "win32", arch: "arm64" })).toBe(
      "@openai/codex-win32-arm64",
    );
  });
});

describe("codexNativeBinaryCandidates", () => {
  it("probes the hoisted layout first, then the nested fallbacks", () => {
    const candidates = codexNativeBinaryCandidates("/root", {
      platform: "darwin",
      arch: "arm64",
    });
    expect(candidates[0]).toBe(
      "/root/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex",
    );
    // The launcher falls back to @openai/codex's own vendor dir when the
    // platform package cannot be resolved, so we must check it too.
    expect(candidates).toContain(
      "/root/node_modules/@openai/codex/vendor/aarch64-apple-darwin/bin/codex",
    );
    // Nested-under-adapter layout (hoisting blocked).
    expect(
      candidates.some((c) =>
        c.includes(path.join("@agentclientprotocol", "codex-acp", "node_modules")),
      ),
    ).toBe(true);
  });

  it("looks for codex.exe on win32", () => {
    const candidates = codexNativeBinaryCandidates("/root", {
      platform: "win32",
      arch: "x64",
    });
    expect(candidates[0]).toBe(
      path.join(
        "/root",
        "node_modules",
        "@openai",
        "codex-win32-x64",
        "vendor",
        "x86_64-pc-windows-msvc",
        "bin",
        "codex.exe",
      ),
    );
  });
});

describe("resolveCodexNativeBinary / codexNativeBinaryPresent", () => {
  it("finds a hoisted engine binary", () => {
    const root = makeRoot();
    const bin = seedBinary(root, "@openai/codex-darwin-arm64", "aarch64-apple-darwin");
    expect(
      resolveCodexNativeBinary(root, { platform: "darwin", arch: "arm64" }),
    ).toBe(bin);
    expect(codexNativeBinaryPresent(root, { platform: "darwin", arch: "arm64" })).toBe(
      true,
    );
  });

  it("finds the launcher's @openai/codex/vendor fallback", () => {
    const root = makeRoot();
    const bin = seedBinary(root, "@openai/codex", "aarch64-apple-darwin");
    expect(
      resolveCodexNativeBinary(root, { platform: "darwin", arch: "arm64" }),
    ).toBe(bin);
  });

  it("finds an engine binary nested under the adapter when hoisting was blocked", () => {
    const root = makeRoot();
    const nestedRoot = path.join(
      root,
      "node_modules",
      "@agentclientprotocol",
      "codex-acp",
    );
    const bin = seedBinary(
      nestedRoot,
      "@openai/codex-darwin-arm64",
      "aarch64-apple-darwin",
    );
    expect(
      resolveCodexNativeBinary(root, { platform: "darwin", arch: "arm64" }),
    ).toBe(bin);
  });

  it("returns null on the partial-install tree npm's silent optional-dep failure produces", () => {
    // Adapter present, engine absent — the exact state this module exists to
    // catch. (The adapter package alone proves nothing.)
    const root = makeRoot();
    const adapterEntry = path.join(
      root,
      "node_modules",
      "@agentclientprotocol",
      "codex-acp",
      "dist",
      "index.js",
    );
    mkdirSync(path.dirname(adapterEntry), { recursive: true });
    writeFileSync(adapterEntry, "// adapter\n");

    expect(
      resolveCodexNativeBinary(root, { platform: "darwin", arch: "arm64" }),
    ).toBeNull();
    expect(
      codexNativeBinaryPresent(root, { platform: "darwin", arch: "arm64" }),
    ).toBe(false);
  });

  it("ignores a binary for the wrong platform/arch", () => {
    const root = makeRoot();
    seedBinary(root, "@openai/codex-linux-x64", "x86_64-unknown-linux-musl");
    expect(
      codexNativeBinaryPresent(root, { platform: "darwin", arch: "arm64" }),
    ).toBe(false);
  });

  it("ignores a binary sitting under the WRONG triple in the right package", () => {
    // Guards the triple half of the path specifically: right package, wrong
    // vendor dir must not count.
    const root = makeRoot();
    seedBinary(root, "@openai/codex-darwin-arm64", "x86_64-apple-darwin");
    expect(
      codexNativeBinaryPresent(root, { platform: "darwin", arch: "arm64" }),
    ).toBe(false);
  });
});

describe("codexNativeBinaryMissingError", () => {
  it("names the platform package, the real cause, and the recovery", () => {
    const msg = codexNativeBinaryMissingError("/some/root", {
      platform: "darwin",
      arch: "arm64",
    });
    expect(msg).toContain("@openai/codex-darwin-arm64");
    expect(msg).toContain("/some/root");
    expect(msg).toContain("optional dependency");
    expect(msg).toContain("reinstall libi");
  });
});
