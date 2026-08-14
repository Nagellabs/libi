import { describe, it, expect } from "vitest";
import { sessionMetaFor } from "@/lib/sessions/session-meta";

describe("sessionMetaFor", () => {
  it("returns the claude-namespaced thinking meta for claude-code", () => {
    expect(sessionMetaFor("claude-code")).toEqual({
      claudeCode: {
        options: {
          thinking: { type: "adaptive", display: "summarized" },
        },
      },
    });
  });

  it("returns an empty object for codex (no claudeCode key)", () => {
    const meta = sessionMetaFor("codex");
    expect(meta).toEqual({});
    expect("claudeCode" in meta).toBe(false);
  });

  it("returns an empty object for any other agent", () => {
    expect(sessionMetaFor("some-other")).toEqual({});
  });
});
