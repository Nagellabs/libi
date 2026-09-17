/**
 * Turning the ONE auth failure the user cannot otherwise see into rendered,
 * actionable text.
 *
 * Originally this served the prompt path only, and that narrowness was itself a
 * bug: the module knew codex fails at `session/new` rather than
 * `session/prompt`, said so in its own comments — and was still wired ONLY into
 * the prompt catch. So its codex branch could never render for the scenario it
 * named. It is now called from the session-creation paths too, via
 * `SessionManager#markAgentAuthFailure`, and takes an `AuthNoteContext` so the
 * wording matches where the failure actually happened.
 *
 * Claude Code availability is decided by the ACP adapter being installed and
 * the user's own `claude` resolving — deliberately NOT by whether the user is
 * signed in (no cheap boot-time probe can answer that honestly: credentials
 * live in the macOS Keychain, or `~/.claude/.credentials.json`, or
 * `ANTHROPIC_API_KEY`, or Bedrock/Vertex env). The cost of that choice is that an unauthenticated user
 * gets through selection and fails at their FIRST message: the adapter answers
 * `initialize` and `session/new` happily, then throws ACP `-32000
 * Authentication required` from `session/prompt` (verified against
 * claude-agent-acp 0.44.0, which raises it on the CLI's "Please run /login").
 *
 * That error is otherwise INVISIBLE. `session-manager` emits it as
 * `agent-status: { status: "error", error }`, and the client
 * (`hooks/sessions/use-agent-chat.ts`) uses only the status string — the
 * message text is dropped, so the user watches their message disappear into
 * nothing and concludes libi is broken. A `chat-note` renders as a finished
 * message, which is the one channel that reaches them.
 *
 * Deliberately narrow: ONLY the auth error produces a note. Every other prompt
 * failure keeps its existing behaviour rather than gaining a new class of
 * system-authored chat noise.
 */

import { getAgentSetup } from "@/lib/agents/setup/registry";

/** ACP `RequestError.authRequired()` — see @agentclientprotocol/sdk. */
export const ACP_AUTH_REQUIRED_CODE = -32000;

/**
 * True when `err` is the ACP auth-required rejection. Matches the numeric
 * code first (the contract) and falls back to the message the SDK builds from
 * it, so a transport that loses the code still classifies.
 */
export function isAuthRequiredError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === ACP_AUTH_REQUIRED_CODE) return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /authentication required/i.test(message);
}

/**
 * WHERE the auth failure was caught. The two agents fail at different points,
 * and a note written for one reads as nonsense in the other:
 *
 *   - `"prompt"`       — Claude's case. A session exists and the user has just
 *                        sent something, so "that message" refers to a real
 *                        thing on screen.
 *   - `"session-start"` — Codex's case. `session/new` rejects, so there is no
 *                        session, no chat, and NO MESSAGE. Saying "it couldn't
 *                        run that message" here invents one, and sends the user
 *                        looking for a message that was never sent. Caught in
 *                        live QA, where the generic branch below rendered
 *                        exactly that.
 */
export type AuthNoteContext = "prompt" | "session-start";

/**
 * Display name for an agent id. Reads `lib/agents/setup/registry.ts` — pure,
 * no filesystem — rather than `lib/agents/acp/agent-registry.ts`, which would
 * drag the whole detection stack into a module the browser bundle reaches.
 * Was two ids kept in sync by hand (`if (agentId === "claude-code") return
 * "Claude Code"; …`); anything the registry doesn't know still falls back to
 * the raw id rather than guessing a prettier form.
 */
function agentLabel(agentId: string): string {
  return getAgentSetup(agentId)?.name ?? agentId;
}

/**
 * The note to post for a failed prompt or a failed session start, or null to
 * stay silent.
 *
 * WAS two hardcoded `if (agentId === "claude-code") … if (agentId ===
 * "codex") …` blocks, then a branch on the registry's `install` field that
 * told the user to INSTALL the agent and sign in. The install half is gone:
 * an auth error only ever arrives from an installed, running agent, libi
 * installs both adapters on selection anyway, and the command it named
 * (`npm i -g @agentclientprotocol/codex-acp`) installs the adapter — it puts
 * no `codex` on PATH, so the sentence could not be followed. Every registered
 * agent now gets the same shape: sign in with the registry's
 * `AgentSignInDeclaration.displayCommand`, nothing about installing.
 *
 * The API-key alternative comes from `AgentSignInDeclaration.envVar`, so the
 * one shape does not carry Anthropic's variable to agents it is wrong for; an
 * agent that declares none simply doesn't get that sentence.
 */
export function promptErrorNote(
  err: unknown,
  agentId: string,
  context: AuthNoteContext = "prompt",
): string | null {
  if (!isAuthRequiredError(err)) return null;
  const blocked =
    context === "prompt"
      ? "so it couldn't run that message"
      : "so libi can't start a chat with it";

  const setup = getAgentSetup(agentId);

  if (setup) {
    const retry = context === "prompt" ? " — then send it again." : ".";
    // The env-var alternative is a REGISTRY field, not a literal. It used to
    // be `ANTHROPIC_API_KEY` hardcoded inside a branch that had just been
    // widened from `agentId === "claude-code"` to every registered agent —
    // so Anthropic's variable would have been recommended to the next
    // agent's users. An agent that declares none loses the clause entirely
    // rather than being handed someone else's.
    const envClause = setup.signIn.envVar ? `, or set \`${setup.signIn.envVar}\`` : "";
    return (
      `${setup.name} isn't signed in on this machine, ${blocked}. ` +
      `Sign in from Agents → ${setup.name}, or run \`${setup.signIn.displayCommand}\` in any terminal` +
      `${envClause}${retry}`
    );
  }
  return `${agentLabel(agentId)} isn't signed in on this machine, ${blocked}.`;
}
