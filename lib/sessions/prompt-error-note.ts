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
 * Claude Code availability is decided by what libi installs — the ACP adapter
 * plus the Claude CLI it execs — and deliberately NOT by whether the user is
 * signed in (`lib/agents/acp/agent-registry.ts#detectClaudeCode` explains why
 * no cheap boot-time probe can answer that honestly: credentials live in the
 * macOS Keychain, or `~/.claude/.credentials.json`, or `ANTHROPIC_API_KEY`, or
 * Bedrock/Vertex env). The cost of that choice is that an unauthenticated user
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
 * Display name for an agent id. The canonical labels live on the registry
 * entries (`lib/agents/acp/agent-registry.ts` — `name: "Claude Code"`), but
 * importing that here would drag the whole detection stack into a module the
 * browser bundle reaches. Two ids, kept in sync by hand; anything else falls
 * back to the raw id rather than guessing a prettier form.
 */
function agentLabel(agentId: string): string {
  if (agentId === "claude-code") return "Claude Code";
  if (agentId === "codex") return "Codex";
  return agentId;
}

/**
 * The note to post for a failed prompt or a failed session start, or null to
 * stay silent.
 *
 * The Claude wording matches `components/onboarding/onboarding-panel.tsx`'s
 * install hint rather than inventing a second set of instructions — both name
 * a sign-in libi cannot perform on the user's behalf.
 *
 * Codex gets its own wording because its remedy is genuinely different: libi
 * BUNDLES the codex engine (~271MB, verified running on a machine with no
 * `codex` on PATH), so signing in requires no installation at all. Telling a
 * codex user to `npm i -g @openai/codex` would be wrong twice over — they
 * already have it, and installing does not sign anyone in.
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

  if (agentId === "claude-code") {
    const retry = context === "prompt" ? " — then send it again." : ".";
    return (
      `Claude Code isn't signed in on this machine, ${blocked}. ` +
      "Sign in once — install Claude Code (`npm i -g @anthropic-ai/claude-code`) and run " +
      `\`claude\`, or set \`ANTHROPIC_API_KEY\`${retry}`
    );
  }
  if (agentId === "codex") {
    return (
      `Codex isn't signed in on this machine, ${blocked}. ` +
      "Sign in using the Codex engine libi already ships — there's nothing to install."
    );
  }
  return `${agentLabel(agentId)} isn't signed in on this machine, ${blocked}.`;
}
