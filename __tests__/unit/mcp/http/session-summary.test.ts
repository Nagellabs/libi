import { describe, it, expect } from "vitest";
import { summarizeSessions } from "@/mcp/http/session-summary";

describe("summarizeSessions", () => {
  it("counts by surface and dialect, zero-filled", () => {
    expect(summarizeSessions([])).toEqual({ inApp: { claude: 0, codex: 0 }, cli: { claude: 0, codex: 0 } });
    expect(
      summarizeSessions([
        { surface: "in-app", dialect: "claude" },
        { surface: "in-app", dialect: "claude" },
        { surface: "cli", dialect: "codex" },
        { surface: "in-app", dialect: "codex" },
      ]),
    ).toEqual({ inApp: { claude: 2, codex: 1 }, cli: { claude: 0, codex: 1 } });
  });
});
