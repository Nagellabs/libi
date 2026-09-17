import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { ensureCodexHome, resolveCodexHome } from "@/lib/codex-config/canonical";

// Every case points HOME at a scratch dir, so a resolution to `~/.codex` can
// never name — or, through ensureCodexHome, create — the real one.
let scratchHome: string;
beforeEach(() => {
  scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), "libi-codex-home-"));
  vi.stubEnv("HOME", scratchHome);
  vi.stubEnv("USERPROFILE", scratchHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(scratchHome, { recursive: true, force: true });
});

describe("resolveCodexHome", () => {
  it("returns CODEX_HOME when set (always wins)", () => {
    vi.stubEnv("CODEX_HOME", "/custom/codex/home");
    vi.stubEnv("LIBI_TEST_MODE", "1");
    expect(resolveCodexHome()).toBe("/custom/codex/home");
  });

  it("resolves to the user's ~/.codex on the installed app (default libi home)", () => {
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("LIBI_HOME", "");
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(resolveCodexHome()).toBe(path.join(scratchHome, ".codex"));
  });

  it("resolves to the user's ~/.codex from a git worktree too, as Claude Code uses ~/.claude.json", () => {
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("LIBI_HOME", path.join(scratchHome, ".libi", "worktrees", "editor-improvements"));
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(resolveCodexHome()).toBe(path.join(scratchHome, ".codex"));
  });

  it("resolves to the user's ~/.codex for any other libi home outside test mode", () => {
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("LIBI_HOME", "/tmp/some-other-libi-home");
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(resolveCodexHome()).toBe(path.join(scratchHome, ".codex"));
  });

  it("resolves to a scoped <LIBI_HOME>/.codex under test mode, never the user's", () => {
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("LIBI_HOME", "/tmp/eval-libi-home");
    vi.stubEnv("LIBI_TEST_MODE", "1");
    expect(resolveCodexHome()).toBe(path.join("/tmp/eval-libi-home", ".codex"));
    expect(resolveCodexHome()).not.toBe(path.join(scratchHome, ".codex"));
  });

  it("reads env fresh each call (no caching)", () => {
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("LIBI_HOME", "/tmp/eval-libi-home");
    vi.stubEnv("LIBI_TEST_MODE", "1");
    expect(resolveCodexHome()).toBe(path.join("/tmp/eval-libi-home", ".codex"));
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(resolveCodexHome()).toBe(path.join(scratchHome, ".codex"));
  });
});

describe("ensureCodexHome", () => {
  // Not a convenience: codex EXITS 1 when CODEX_HOME names a directory that
  // does not exist ("CODEX_HOME points to … but that path does not exist"),
  // which is exactly how a scoped home broke the ACP child on 2026-08-16.
  it("creates a scoped test-mode home, parents and all", () => {
    const home = path.join(scratchHome, "nested", "libi-home");
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("LIBI_HOME", home);
    vi.stubEnv("LIBI_TEST_MODE", "1");

    const resolved = ensureCodexHome();

    expect(resolved).toBe(path.join(home, ".codex"));
    expect(fs.statSync(resolved).isDirectory()).toBe(true);
  });

  it("creates the user's ~/.codex when a worktree finds it missing", () => {
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("LIBI_HOME", path.join(scratchHome, ".libi", "worktrees", "wt"));
    vi.stubEnv("LIBI_TEST_MODE", "");

    const resolved = ensureCodexHome();

    expect(resolved).toBe(path.join(scratchHome, ".codex"));
    expect(fs.statSync(resolved).isDirectory()).toBe(true);
  });

  it("is idempotent and leaves an existing home untouched", () => {
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("LIBI_HOME", scratchHome);
    vi.stubEnv("LIBI_TEST_MODE", "1");
    const marker = path.join(scratchHome, ".codex", "config.toml");

    ensureCodexHome();
    fs.writeFileSync(marker, "# mine\n");
    expect(ensureCodexHome()).toBe(path.join(scratchHome, ".codex"));

    expect(fs.readFileSync(marker, "utf-8")).toBe("# mine\n");
  });

  it("never throws when the directory cannot be created — a spawn must not die over this", () => {
    // A FILE where the home should be: mkdir fails with EEXIST/ENOTDIR.
    const home = path.join(scratchHome, "blocked");
    fs.writeFileSync(home, "not a directory");
    vi.stubEnv("CODEX_HOME", path.join(home, ".codex"));

    expect(() => ensureCodexHome()).not.toThrow();
    expect(ensureCodexHome()).toBe(path.join(home, ".codex"));
  });
});
