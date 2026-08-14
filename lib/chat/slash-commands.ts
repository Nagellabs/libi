/**
 * Pure logic for the composer's slash-command palette.
 *
 * ACP contract: invoking an advertised command = sending a normal prompt
 * whose text is "/name args". The ONLY client-side special case is /clear
 * (claude-agent-acp deliberately filters `clear` from its advertised list;
 * the ACP-native equivalent is starting a new session) — we inject a local
 * entry and intercept it on submit as the New-chat action.
 */

import type { AvailableCommandInfo } from "@/lib/sessions/usage";

export interface PaletteCommand extends AvailableCommandInfo {
  /** true for the client-injected /clear entry (never sent to the agent). */
  local?: boolean;
}

const CLEAR_COMMAND: PaletteCommand = {
  name: "clear",
  description: "Start a new chat",
  inputHint: null,
  local: true,
};

/** The token being typed after "/", up to the first whitespace. */
function commandToken(input: string): string | null {
  if (!input.startsWith("/")) return null;
  const ws = input.search(/\s/);
  return input.slice(1, ws === -1 ? input.length : ws);
}

/**
 * Palette rows for the current input. The local /clear entry is always
 * offered first. Prefix matches rank alone; when none exist, substring
 * matches are shown. Case-insensitive.
 *
 * An agent-advertised `clear` (possible from non-claude CLIs) is dropped in
 * favor of the local entry: submit intercepts `/clear` as New chat no matter
 * what, so showing the agent's row would advertise something uninvokable —
 * and duplicate `name`s would collide as React keys downstream.
 */
export function filterCommands(
  input: string,
  commands: AvailableCommandInfo[],
): PaletteCommand[] {
  const token = (commandToken(input) ?? "").toLowerCase();
  const deduped = commands.filter((c) => c.name.toLowerCase() !== "clear");
  const all: PaletteCommand[] = [CLEAR_COMMAND, ...deduped];
  if (!token) return all;
  const prefix = all.filter((c) => c.name.toLowerCase().startsWith(token));
  if (prefix.length > 0) return prefix;
  return all.filter((c) => c.name.toLowerCase().includes(token));
}

/** "new-chat" when the (trimmed) input invokes /clear; null otherwise.
 *  Any whitespace (space, tab, newline) ends the command token — aligned
 *  with the `\s`-based tokenization in commandToken/shouldShowPalette. */
export function interceptCommand(input: string): "new-chat" | null {
  return /^\/clear(\s|$)/.test(input.trim()) ? "new-chat" : null;
}

/**
 * The palette is open while the caret sits inside the FIRST token of an
 * input that starts with "/" (position ≥ 1 — caret 0 is before the slash).
 * A "/" mid-message never opens it.
 */
export function shouldShowPalette(input: string, caretPos: number): boolean {
  if (!input.startsWith("/")) return false;
  const ws = input.search(/\s/);
  const firstTokenEnd = ws === -1 ? input.length : ws;
  return caretPos >= 1 && caretPos <= firstTokenEnd;
}

/** Text inserted when a palette row is chosen. Trailing space iff the
 *  command takes input, so the user can keep typing args immediately. */
export function completionText(command: PaletteCommand): string {
  return command.inputHint ? `/${command.name} ` : `/${command.name}`;
}
