import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { claudeInChromeEnabled, sessionMetaFor } from "@/lib/sessions/session-meta";

const off = () => false;
const on = () => true;

describe("sessionMetaFor", () => {
  it("returns the claude-namespaced thinking meta for claude-code", () => {
    expect(sessionMetaFor("claude-code", {}, null, off)).toEqual({
      claudeCode: {
        options: {
          thinking: { type: "adaptive", display: "summarized" },
        },
      },
    });
  });

  it("drops the user setting source only when test mode AND the skip flag are both set", () => {
    const opts = (env: Record<string, string>) =>
      (sessionMetaFor("claude-code", env, null, off) as { claudeCode: { options: Record<string, unknown> } })
        .claudeCode.options;
    expect(opts({ LIBI_TEST_MODE: "1", LIBI_AGENT_SKIP_USER_SETTINGS: "1" }).settingSources).toEqual([
      "project",
      "local",
    ]);
    // Either flag alone leaves the adapter's default (user + project + local).
    expect("settingSources" in opts({ LIBI_AGENT_SKIP_USER_SETTINGS: "1" })).toBe(false);
    expect("settingSources" in opts({ LIBI_TEST_MODE: "1" })).toBe(false);
    expect("settingSources" in opts({})).toBe(false);
    // Codex never gets the claude bag, flag or not.
    expect(sessionMetaFor("codex", { LIBI_TEST_MODE: "1", LIBI_AGENT_SKIP_USER_SETTINGS: "1" })).toEqual({});
  });

  it("returns an empty object for codex (no claudeCode key)", () => {
    const meta = sessionMetaFor("codex");
    expect(meta).toEqual({});
    expect("claudeCode" in meta).toBe(false);
  });

  it("hands a Claude chat the login-shell folders libi's own PATH lacks, after its own, and nothing when there are none", () => {
    const env = { PATH: "/usr/bin:/bin" };
    const opts = (dirs: string[] | null) =>
      (sessionMetaFor("claude-code", env, dirs, off) as { claudeCode: { options: Record<string, unknown> } }).claudeCode.options;
    // uv installed after libi booted: its folder is on the login shell's PATH, not on libi's.
    expect(opts(["/Users/me/.local/bin", "/usr/bin"]).env).toEqual({ PATH: "/usr/bin:/bin:/Users/me/.local/bin" });
    expect("env" in opts(["/usr/bin", "/bin"])).toBe(false);
    expect("env" in opts([])).toBe(false);
    expect("env" in opts(null)).toBe(false);
    // Codex reads its MCP servers in its own long-lived process: no per-chat environment.
    expect(sessionMetaFor("codex", env, ["/Users/me/.local/bin"])).toEqual({});
  });

  it("starts a Claude chat with --chrome only when the user enabled Claude in Chrome, and never in a hermetic eval", () => {
    const opts = (env: Record<string, string>, chrome: () => boolean) =>
      (sessionMetaFor("claude-code", env, null, chrome) as { claudeCode: { options: Record<string, unknown> } })
        .claudeCode.options;
    // `null` is the SDK's spelling of a value-less flag: `--chrome`.
    expect(opts({}, on).extraArgs).toEqual({ chrome: null });
    expect("extraArgs" in opts({}, off)).toBe(false);
    // skill-eval's hermetic mode never asks the host's setting.
    let asked = false;
    expect("extraArgs" in opts({ LIBI_TEST_MODE: "1", LIBI_AGENT_SKIP_USER_SETTINGS: "1" }, () => (asked = true))).toBe(false);
    expect(asked).toBe(false);
    // Codex has no such flag.
    expect(sessionMetaFor("codex", {}, null, on)).toEqual({});
  });

  it("reads Claude in Chrome from the user's own .claude.json (honouring CLAUDE_CONFIG_DIR), off on anything else", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "libi-chrome-"));
    const env = { CLAUDE_CONFIG_DIR: dir };
    const write = (body: string) => fs.writeFileSync(path.join(dir, ".claude.json"), body);
    try {
      expect(claudeInChromeEnabled(env)).toBe(false); // no file
      write(JSON.stringify({ claudeInChromeDefaultEnabled: true }));
      expect(claudeInChromeEnabled(env)).toBe(true);
      write(JSON.stringify({ claudeInChromeDefaultEnabled: false }));
      expect(claudeInChromeEnabled(env)).toBe(false);
      write(JSON.stringify({ claudeInChromeDefaultEnabled: "true" }));
      expect(claudeInChromeEnabled(env)).toBe(false);
      write("{ half-written");
      expect(claudeInChromeEnabled(env)).toBe(false);
      write("null");
      expect(claudeInChromeEnabled(env)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns an empty object for any other agent", () => {
    expect(sessionMetaFor("some-other")).toEqual({});
  });
});
