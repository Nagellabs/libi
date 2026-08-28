import { describe, it, expect, vi } from "vitest";

import {
  ACP_AUTH_REQUIRED_CODE,
  isAuthRequiredError,
  promptErrorNote,
} from "@/lib/sessions/prompt-error-note";

/**
 * Claude Code is reported available on the strength of the adapter + the CLI
 * libi installs, NOT on whether the user has ever signed in (no cheap
 * boot-time probe can answer that honestly — see
 * lib/agents/acp/agent-registry.ts#detectClaudeCode). The trade is that an
 * unauthenticated user fails at their first message with ACP -32000, which the
 * chat client drops on the floor. This helper is what makes that one failure
 * visible and actionable.
 */
describe("isAuthRequiredError", () => {
  it("classifies the ACP RequestError.authRequired() shape by code", () => {
    const err = Object.assign(new Error("Authentication required"), {
      code: ACP_AUTH_REQUIRED_CODE,
    });
    expect(isAuthRequiredError(err)).toBe(true);
  });

  it("still classifies when only the message survives the transport", () => {
    expect(isAuthRequiredError(new Error("Authentication required"))).toBe(true);
  });

  it("does not classify unrelated prompt failures", () => {
    expect(isAuthRequiredError(new Error("Connection closed"))).toBe(false);
    expect(
      isAuthRequiredError(Object.assign(new Error("Invalid params"), { code: -32602 })),
    ).toBe(false);
    expect(isAuthRequiredError(null)).toBe(false);
    expect(isAuthRequiredError("Authentication required")).toBe(false);
  });
});

describe("promptErrorNote", () => {
  const authErr = Object.assign(new Error("Authentication required"), {
    code: ACP_AUTH_REQUIRED_CODE,
  });

  it("tells a Claude Code user they are not signed in, and how to fix it", () => {
    const note = promptErrorNote(authErr, "claude-code");
    expect(note).toBeTruthy();
    expect(note!.toLowerCase()).toContain("signed in");
    // Actionable: names both routes a user actually has.
    expect(note).toContain("claude");
    expect(note).toContain("ANTHROPIC_API_KEY");
    // Must NOT resurrect the misleading advice this whole fix removed: the
    // adapter resolves the CLI by package, never through PATH.
    expect(note).not.toContain("PATH");
  });

  it("stays silent for every other prompt failure", () => {
    expect(promptErrorNote(new Error("Connection closed"), "claude-code")).toBeNull();
    expect(promptErrorNote(new Error("stream ended"), "codex")).toBeNull();
  });

  it("still names the problem for a non-Claude agent", () => {
    expect(promptErrorNote(authErr, "codex")).toContain("signed in");
  });
});

/**
 * The wording must match WHERE the failure happened.
 *
 * Found in live QA, not by a unit test: the generic branch rendered
 * "…couldn't run that message" for codex, whose auth failure fires at
 * `session/new` — before any session, chat, or message exists. It sent the
 * reader looking for a message that was never sent.
 *
 * The pre-existing codex assertion above is `toContain("signed in")`, which
 * passes for both the right and the wrong string — which is exactly why it
 * never caught this. These assert the distinction itself.
 */
describe("context-appropriate wording", () => {
  const authErr = { code: -32000, message: "Authentication required" };

  it("never invents a message that was never sent, at session start", () => {
    for (const agentId of ["claude-code", "codex", "some-future-agent"]) {
      const note = promptErrorNote(authErr, agentId, "session-start");
      expect(note, `${agentId} produced no note`).toBeTruthy();
      expect(
        note,
        `${agentId}: "that message" is a lie at session start — nothing was sent yet`,
      ).not.toContain("that message");
    }
  });

  it("still refers to the message on the prompt path, where one exists", () => {
    expect(promptErrorNote(authErr, "claude-code", "prompt")).toContain("that message");
    expect(promptErrorNote(authErr, "codex", "prompt")).toContain("that message");
  });

  it("defaults to the prompt wording, preserving the original call signature", () => {
    expect(promptErrorNote(authErr, "claude-code")).toBe(
      promptErrorNote(authErr, "claude-code", "prompt"),
    );
  });

  it("does not tell a codex user to install what libi already ships", () => {
    // libi bundles the codex engine, so the remedy is sign-in, not install.
    // `npm i -g @openai/codex` would be wrong twice: they have it, and
    // installing signs nobody in.
    for (const ctx of ["prompt", "session-start"] as const) {
      const note = promptErrorNote(authErr, "codex", ctx) ?? "";
      expect(note).not.toMatch(/npm i(nstall)? -g/);
      expect(note).toContain("nothing to install");
    }
  });

  it("uses a display name, not a raw id, for an unknown agent", () => {
    expect(promptErrorNote(authErr, "codex", "session-start")).toContain("Codex");
    expect(promptErrorNote(authErr, "claude-code", "session-start")).toContain(
      "Claude Code",
    );
  });
});

/**
 * Finding 5: the de-hardcoding made Anthropic-specific advice reachable by
 * agents it is wrong for.
 *
 * The branch was `if (agentId === "claude-code")`, where naming
 * `ANTHROPIC_API_KEY` is correct. It became `if (setup?.install)` — "any agent
 * libi has to install" — while every other string in the branch interpolates
 * from the registry and that one stayed literal. A third installable agent
 * would be told to set Anthropic's environment variable.
 *
 * The fix keeps the de-hardcoding: the variable is a registry field, and the
 * sentence naming it is omitted entirely for an agent that declares none.
 */
describe("environment-variable advice comes from the registry, not the branch", () => {
  const authErr = { code: -32000, message: "Authentication required" };

  it("names ANTHROPIC_API_KEY for Claude Code, which declares it", async () => {
    const { getAgentSetup } = await import("@/lib/agents/setup/registry");
    expect(getAgentSetup("claude-code")!.signIn.envVar).toBe("ANTHROPIC_API_KEY");
    expect(promptErrorNote(authErr, "claude-code")).toContain("ANTHROPIC_API_KEY");
  });

  it("omits the sentence entirely for an installable agent that declares no variable", async () => {
    const { getAgentSetup } = await import("@/lib/agents/setup/registry");
    const claude = getAgentSetup("claude-code")!;
    const thirdAgent = {
      ...claude,
      id: "third-agent",
      name: "Third Agent",
      signIn: { ...claude.signIn, envVar: undefined },
    };
    vi.resetModules();
    vi.doMock("@/lib/agents/setup/registry", () => ({
      getAgentSetup: (id: string) => (id === "third-agent" ? thirdAgent : null),
    }));
    try {
      const fresh = await import("@/lib/sessions/prompt-error-note");
      const note = fresh.promptErrorNote(authErr, "third-agent") ?? "";
      expect(note).toContain("Third Agent");
      expect(note).not.toContain("ANTHROPIC_API_KEY");
      // No dangling "or set ``" fragment where the variable used to be.
      expect(note).not.toMatch(/or set/);
    } finally {
      vi.doUnmock("@/lib/agents/setup/registry");
      vi.resetModules();
    }
  });

  it("never mentions an env var for an agent libi already ships", () => {
    expect(promptErrorNote(authErr, "codex")).not.toContain("API_KEY");
  });
});
