/**
 * Whether a built-in tool call's refined title is LESS specific than the one its row already
 * shows, and so must not replace it. Shared by the server cache (`SessionEventHandler`
 * `adoptToolCallTitle`) and the chat reducer (`applyToolTitle`), so the live row and the history a
 * refresh serves always agree.
 *
 * Titles only ever get more specific: claude-agent-acp builds each update's title from the input
 * it has so far, but codex-acp's built-in (exec/patch) titles were never audited, and a vaguer
 * title on completion would replace a specific one. Two shapes count as less specific:
 *   - a placeholder over a title that is not one. A placeholder is the adapters' shape — one to
 *     three plain words and an ellipsis ("Preparing file…", "Loading session..."); a real title
 *     that merely ends in one (`echo waiting...`, a path, free text of four words or more) is
 *     adopted like any other (review M4);
 *   - a strict prefix of the current title ("Edit" after "Edit notes.md").
 * A different title that is just as specific ("Ran npm test" after "Run npm test") is adopted.
 *
 * Presentation only — a codex tool call is never canonicalized from its title (`toolIdForCall`).
 */
export function isLessSpecificToolTitle(current: string | null | undefined, next: string): boolean {
  const cur = (current ?? "").trim();
  const nx = next.trim();
  if (!cur || !nx || cur === nx) return false;
  if (isPlaceholderTitle(nx) && !isPlaceholderTitle(cur)) return true;
  return cur.startsWith(nx);
}

function isPlaceholderTitle(title: string): boolean {
  return /^[A-Za-z]+(?: [A-Za-z]+){0,2}(?:…|\.\.\.)$/.test(title);
}
