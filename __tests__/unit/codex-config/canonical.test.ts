import fs from "fs";
import os from "os";
import path from "path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ensureCodexHome,
  isCanonicalLibiInstance,
  resolveCodexHome,
} from "@/lib/codex-config/canonical";

afterEach(() => vi.unstubAllEnvs());

describe("isCanonicalLibiInstance", () => {
  it("true when LIBI_HOME is unset (default ~/.libi) and test mode off", () => {
    vi.stubEnv("LIBI_HOME", "");
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(isCanonicalLibiInstance()).toBe(true);
  });

  it("true when LIBI_HOME points explicitly at the default ~/.libi", () => {
    vi.stubEnv("LIBI_HOME", path.join(os.homedir(), ".libi"));
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(isCanonicalLibiInstance()).toBe(true);
  });

  it("false when LIBI_HOME points to a worktree home", () => {
    vi.stubEnv(
      "LIBI_HOME",
      path.join(os.homedir(), ".libi", "worktrees", "editor-improvements"),
    );
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(isCanonicalLibiInstance()).toBe(false);
  });

  it("false when LIBI_HOME points anywhere else entirely", () => {
    vi.stubEnv("LIBI_HOME", "/tmp/some-other-libi-home");
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(isCanonicalLibiInstance()).toBe(false);
  });

  it("false when test mode is on even at the default home", () => {
    vi.stubEnv("LIBI_HOME", "");
    vi.stubEnv("LIBI_TEST_MODE", "1");
    expect(isCanonicalLibiInstance()).toBe(false);
  });

  it("reads env fresh each call (no caching)", () => {
    vi.stubEnv("LIBI_TEST_MODE", "");
    vi.stubEnv("LIBI_HOME", "/tmp/not-canonical");
    expect(isCanonicalLibiInstance()).toBe(false);
    vi.stubEnv("LIBI_HOME", path.join(os.homedir(), ".libi"));
    expect(isCanonicalLibiInstance()).toBe(true);
  });
});

describe("resolveCodexHome", () => {
  it("returns CODEX_HOME when set (always wins)", () => {
    vi.stubEnv("CODEX_HOME", "/custom/codex/home");
    expect(resolveCodexHome()).toBe("/custom/codex/home");
  });

  it("resolves to the real ~/.codex on a canonical instance", () => {
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("LIBI_HOME", "");
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(resolveCodexHome()).toBe(path.join(os.homedir(), ".codex"));
  });

  it("resolves to a scoped <LIBI_HOME>/.codex in a worktree (never real ~/.codex)", () => {
    vi.stubEnv("CODEX_HOME", "");
    const worktreeHome = path.join(
      os.homedir(),
      ".libi",
      "worktrees",
      "editor-improvements",
    );
    vi.stubEnv("LIBI_HOME", worktreeHome);
    vi.stubEnv("LIBI_TEST_MODE", "");
    expect(resolveCodexHome()).toBe(path.join(worktreeHome, ".codex"));
  });

  it("resolves to a scoped codex home under test mode (never real ~/.codex)", () => {
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("LIBI_HOME", "/tmp/eval-libi-home");
    vi.stubEnv("LIBI_TEST_MODE", "1");
    expect(resolveCodexHome()).toBe(path.join("/tmp/eval-libi-home", ".codex"));
  });
});

describe("ensureCodexHome", () => {
  const made: string[] = [];
  afterEach(() => {
    while (made.length) fs.rmSync(made.pop()!, { recursive: true, force: true });
  });

  // Not a convenience: codex EXITS 1 when CODEX_HOME names a directory that
  // does not exist ("CODEX_HOME points to … but that path does not exist"),
  // which is exactly how a scoped home broke the ACP child on 2026-08-16.
  it("creates the resolved home, parents and all", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ensure-codex-"));
    made.push(root);
    const home = path.join(root, "nested", "libi-home");
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("LIBI_HOME", home);

    const resolved = ensureCodexHome();

    expect(resolved).toBe(path.join(home, ".codex"));
    expect(fs.statSync(resolved).isDirectory()).toBe(true);
  });

  it("is idempotent and leaves an existing home untouched", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ensure-codex-"));
    made.push(root);
    vi.stubEnv("CODEX_HOME", "");
    vi.stubEnv("LIBI_HOME", root);
    const marker = path.join(root, ".codex", "config.toml");

    ensureCodexHome();
    fs.writeFileSync(marker, "# mine\n");
    expect(ensureCodexHome()).toBe(path.join(root, ".codex"));

    expect(fs.readFileSync(marker, "utf-8")).toBe("# mine\n");
  });

  it("never throws when the directory cannot be created — a spawn must not die over this", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "libi-ensure-codex-"));
    made.push(root);
    // A FILE where the home should be: mkdir fails with EEXIST/ENOTDIR.
    const home = path.join(root, "blocked");
    fs.writeFileSync(path.join(root, "blocked"), "not a directory");
    vi.stubEnv("CODEX_HOME", path.join(home, ".codex"));

    expect(() => ensureCodexHome()).not.toThrow();
    expect(ensureCodexHome()).toBe(path.join(home, ".codex"));
  });
});
