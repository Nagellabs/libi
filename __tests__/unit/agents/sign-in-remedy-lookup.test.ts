import { describe, expect, it, vi } from "vitest";

/**
 * Finding 8: indexing a plain object literal by an unvalidated string.
 *
 * `SIGN_IN_RESOLVERS[agentId]?.()` reaches Object.prototype, so
 * `resolveSignInRemedy("constructor")` used to return `Object()` — a truthy
 * `{}` masquerading as a `TerminalRemedy`, which every caller would then try
 * to render and run. Not reachable today (ids come from libi's own provider
 * list), which is exactly the kind of "not reachable yet" that becomes
 * reachable the first time an id arrives from anywhere else.
 */
vi.mock("@/lib/agents/claude-native-binary", () => ({
  resolveClaudeNativeBinary: () => null,
}));

describe("resolveSignInRemedy — prototype keys are not agents", () => {
  it("returns null for Object.prototype members", async () => {
    const { resolveSignInRemedy } = await import("@/lib/agents/acp/sign-in-remedy");
    for (const key of ["constructor", "toString", "hasOwnProperty", "__proto__", "valueOf"]) {
      expect(resolveSignInRemedy(key), `${key} resolved to something`).toBeNull();
    }
  });

  it("still returns null for an ordinary unknown id", async () => {
    const { resolveSignInRemedy } = await import("@/lib/agents/acp/sign-in-remedy");
    expect(resolveSignInRemedy("terminal")).toBeNull();
    expect(resolveSignInRemedy("nope")).toBeNull();
  });
});
