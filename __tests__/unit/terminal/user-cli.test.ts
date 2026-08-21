import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveUserCli } from "@/lib/terminal/user-cli";

/**
 * The terminal preset asks "would the USER's login shell find this name?".
 * That is a different question from agent availability, which AGENTS.md
 * forbids answering with a PATH probe — see the header of user-cli.ts.
 */
describe("resolveUserCli", () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-user-cli-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** Create an executable file and return its directory. */
  function bin(name: string, mode = 0o755): string {
    const dir = path.join(root, "bin");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    fs.writeFileSync(file, "#!/bin/sh\n");
    fs.chmodSync(file, mode);
    return dir;
  }

  it("finds an executable on the search path", () => {
    const dir = bin("claude");
    expect(resolveUserCli("claude", [dir])).toBe(path.join(dir, "claude"));
  });

  it("returns null when nothing matches", () => {
    const dir = bin("codex");
    expect(resolveUserCli("claude", [dir])).toBeNull();
  });

  it("returns null for an empty search path rather than throwing", () => {
    expect(resolveUserCli("claude", [])).toBeNull();
  });

  it("ignores a directory that merely shares the command's name", () => {
    const dir = path.join(root, "bin");
    fs.mkdirSync(path.join(dir, "claude"), { recursive: true });
    expect(resolveUserCli("claude", [dir])).toBeNull();
  });

  it("skips a non-executable file on POSIX", () => {
    if (process.platform === "win32") return; // no execute bit on Windows
    const dir = bin("claude", 0o644);
    expect(resolveUserCli("claude", [dir])).toBeNull();
  });

  it("searches earlier directories first — the login-shell cache outranks own PATH", () => {
    const first = path.join(root, "a");
    const second = path.join(root, "b");
    for (const d of [first, second]) {
      fs.mkdirSync(d, { recursive: true });
      const f = path.join(d, "claude");
      fs.writeFileSync(f, "#!/bin/sh\n");
      fs.chmodSync(f, 0o755);
    }
    expect(resolveUserCli("claude", [first, second])).toBe(path.join(first, "claude"));
  });

  it("treats a path-bearing command as a direct check, not a PATH lookup", () => {
    const dir = bin("claude");
    const abs = path.join(dir, "claude");
    expect(resolveUserCli(abs, [])).toBe(abs);
    expect(resolveUserCli(path.join(root, "nope", "claude"), [dir])).toBeNull();
  });

  it("survives a nonexistent directory in the search path", () => {
    const dir = bin("claude");
    expect(resolveUserCli("claude", [path.join(root, "ghost"), dir])).toBe(
      path.join(dir, "claude"),
    );
  });
});
