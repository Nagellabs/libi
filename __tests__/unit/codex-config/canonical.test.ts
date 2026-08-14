import os from "os";
import path from "path";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
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
