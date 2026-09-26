import { describe, it, expect } from "vitest";
import { sessionMetaFor } from "@/lib/sessions/session-meta";

describe("sessionMetaFor", () => {
  it("returns the claude-namespaced thinking meta for claude-code", () => {
    expect(sessionMetaFor("claude-code", {}, null)).toEqual({
      claudeCode: {
        options: {
          thinking: { type: "adaptive", display: "summarized" },
        },
      },
    });
  });

  it("drops the user setting source only when test mode AND the skip flag are both set", () => {
    const opts = (env: Record<string, string>) =>
      (sessionMetaFor("claude-code", env) as { claudeCode: { options: Record<string, unknown> } })
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
      (sessionMetaFor("claude-code", env, dirs) as { claudeCode: { options: Record<string, unknown> } }).claudeCode.options;
    // uv installed after libi booted: its folder is on the login shell's PATH, not on libi's.
    expect(opts(["/Users/me/.local/bin", "/usr/bin"]).env).toEqual({ PATH: "/usr/bin:/bin:/Users/me/.local/bin" });
    expect("env" in opts(["/usr/bin", "/bin"])).toBe(false);
    expect("env" in opts([])).toBe(false);
    expect("env" in opts(null)).toBe(false);
    // Codex reads its MCP servers in its own long-lived process: no per-chat environment.
    expect(sessionMetaFor("codex", env, ["/Users/me/.local/bin"])).toEqual({});
  });

  it("returns an empty object for any other agent", () => {
    expect(sessionMetaFor("some-other")).toEqual({});
  });
});
