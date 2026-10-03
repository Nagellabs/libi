/** Social results: where an item the agent cannot fix itself is fixed. Pure; no studio access. */

/**
 * A `needs` item the agent cannot satisfy itself: the exact screen that fixes
 * it, for `libi.show`. Open it instead of explaining menus (the prose it used to
 * expand — "reconnect with Facebook Login" — once sent the user to the wrong
 * connection).
 */
export function needsOpen(accountId?: string): { tool: "libi.show"; target: "social_settings"; accountId?: string } {
  return { tool: "libi.show", target: "social_settings", ...(accountId ? { accountId } : {}) };
}
