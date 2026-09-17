/**
 * One agent's state for one provider, as the Providers tab reads it.
 *
 * - `connected` / `needs-key` / `disabled`: what detection read from that
 *   agent's own config (`disabled` is Codex only).
 * - `needs-sign-in`: a provider the user signs in to with an account, which the
 *   agent says is not signed in (Codex only; libi cannot see Claude's).
 * - `sign-in-unknown`: such a provider is added, but libi can't see whether the
 *   agent has signed in to it (every Claude Code entry, and a Codex entry codex
 *   gives no answer for). Never labelled Connected: Claude Code itself calls a
 *   fresh one "Needs authentication".
 * - `not-added`: detection found no entry for this provider.
 * - `agent-not-ready`: the agent has no usable CLI or adapter yet, so there is
 *   nothing to type a command into.
 * - `unknown`: the agent status or detection could not be read, or codex gave
 *   no listing and there is no earlier one. The tab says which, and offers
 *   Retry; the chip claims nothing.
 *
 * A Codex chip whose state comes from codex's last good listing, because the
 * latest one is still running or gave no answer, keeps that state and says
 * "last known" beside it (`stale`).
 */
export type ChipState =
  | "connected"
  | "needs-key"
  | "needs-sign-in"
  | "sign-in-unknown"
  | "disabled"
  | "not-added"
  | "agent-not-ready"
  | "unknown";
