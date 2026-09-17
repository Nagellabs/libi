/**
 * The clipboard shortcuts the inline terminal leaves to the browser.
 *
 * xterm.js turns every Ctrl+letter into its control character and cancels the
 * key, so nothing else sees it: Ctrl+V reaches the shell as ^V and the browser
 * never pastes. On a Mac that costs nothing, because paste is ⌘V, which xterm
 * ignores. On Windows Ctrl+V IS paste, so nothing could be pasted into a setup
 * terminal from the keyboard — not a provider key at its hidden prompt, not a
 * sign-in code. These are the shortcuts Windows Terminal and VS Code's terminal
 * use there: Ctrl+V (and Ctrl+Shift+V, which xterm already leaves alone) pastes,
 * and Ctrl+C copies while text is selected, otherwise it interrupts as it
 * always has.
 */
export type TerminalClipboardShortcut = "paste" | "copy";

type KeyLike = Pick<KeyboardEvent, "keyCode" | "ctrlKey" | "altKey" | "metaKey">;

/** `navigator.platform` as xterm itself reads it: "Win32" in Chromium and Electron on Windows. */
export function isWindowsPlatform(platform: string | undefined): boolean {
  return /^win/i.test(platform ?? "");
}

export function terminalClipboardShortcut(
  ev: KeyLike,
  ctx: { windows: boolean; hasSelection: boolean },
): TerminalClipboardShortcut | null {
  // Ctrl+Alt is AltGr on Windows, which types characters; it is never a shortcut here.
  if (!ctx.windows || !ev.ctrlKey || ev.altKey || ev.metaKey) return null;
  // keyCode, as Chromium's own Ctrl+V binding and xterm's Ctrl+letter mapping read it: the key the layout calls V.
  // Windows keeps it for a non-Latin layout (Hebrew puts ה there), and on Dvorak it follows the letter, so the
  // physical V key there (which types K) stays Ctrl+K.
  if (ev.keyCode === 86) return "paste";
  if (ev.keyCode === 67 && ctx.hasSelection) return "copy";
  return null;
}
