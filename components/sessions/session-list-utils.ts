/**
 * Empty-state copy for the sidebar session list.
 *
 * Agents that can't list past sessions (codex — `canListSessions:false`) only
 * ever surface sessions from the current server run, so "No sessions yet" is
 * misleading (it implies history will accumulate). For those agents we say so
 * honestly, naming the agent when we have a display name.
 *
 * When the agent CAN list sessions (claude-code) the bare "No sessions yet" is
 * correct — history exists, there just isn't any.
 */
export function emptySessionsMessage(
  canListSessions: boolean,
  agentName?: string | null,
): string {
  if (canListSessions) return "No sessions yet";
  const who = agentName?.trim() || "This agent";
  return `${who} doesn't expose past sessions — new chats appear here for this run.`;
}

export function formatSessionDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  if (date >= startOfToday) {
    return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  }

  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
