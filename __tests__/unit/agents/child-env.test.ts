import { describe, it, expect } from "vitest";
import { HOST_SESSION_ENV_MARKERS, stripHostSessionEnv } from "@/lib/agents/child-env";

describe("stripHostSessionEnv", () => {
  it("removes exactly the host Claude Code session markers and nothing else", () => {
    const env = {
      PATH: "/usr/bin",
      HOME: "/Users/me",
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "cli",
      CLAUDE_CODE_SESSION_ID: "s",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_HOST_SESSION_ID: "h",
      CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/sock",
      CLAUDE_CODE_MESSAGING_TOKEN: "t",
      CLAUDE_CODE_EXECPATH: "/x/claude",
      CLAUDE_PID: "123",
      // User configuration stays.
      CLAUDE_CONFIG_DIR: "/cfg",
      CLAUDE_CODE_USE_BEDROCK: "1",
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_BASE_URL: "https://proxy",
      CODEX_HOME: "/c",
    } as unknown as NodeJS.ProcessEnv;
    const out = stripHostSessionEnv(env);
    expect(Object.keys(out).sort()).toEqual(
      ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "HOME", "PATH"],
    );
    expect(env.CLAUDECODE).toBe("1"); // input untouched
    expect([...HOST_SESSION_ENV_MARKERS].sort()).toEqual([
      "CLAUDECODE",
      "CLAUDE_CODE_CHILD_SESSION",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_EXECPATH",
      "CLAUDE_CODE_HOST_SESSION_ID",
      "CLAUDE_CODE_MESSAGING_SOCKET",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_PID",
    ]);
  });
});
