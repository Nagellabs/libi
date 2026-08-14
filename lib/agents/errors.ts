/**
 * Shared agent errors.
 *
 * `NoAgentConfiguredError` is thrown by server actions that need a libi agent
 * but find none active/preferred (bring-your-own-CLI mode). Callers MUST map
 * this to a friendly, non-error UX (e.g. "copy the prompt into your CLI"),
 * never a hard failure.
 */
export class NoAgentConfiguredError extends Error {
  constructor(
    message = "No agent is configured. Select an agent in the sidebar, or copy the prompt into your own CLI.",
  ) {
    super(message);
    this.name = "NoAgentConfiguredError";
  }
}
