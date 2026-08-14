// Shared constants for the first-run "Show me how it works" demo offer, used by
// both surfaces: the chat panel (sends the prompt to the ACP agent) and the
// terminal panel (pastes the prompt into the live PTY for the user's CLI).

/** The prompt that kicks off the onboarding demo. */
export const ONBOARDING_DEMO_PROMPT =
  "Show me how libi works — run the onboarding demo.";

/** Window event the chat panel listens for to send the demo prompt to the ACP agent. */
export const RUN_ONBOARDING_DEMO_EVENT = "libi:run-onboarding-demo";

/** Window event the active terminal view listens for to paste text into its PTY. */
export const TERMINAL_INSERT_TEXT_EVENT = "libi:terminal-insert-text";
