/**
 * Quoting for text pasted into libi's built-in terminal.
 *
 * Scoped to the shells `lib/terminal/pty.ts` actually spawns: `powershell.exe`
 * on Windows, `$SHELL || /bin/zsh|/bin/bash` elsewhere. `cmd.exe` is never
 * spawned, which is what makes single-quote wrapping sufficient for both —
 * inside single quotes both flavors treat the contents literally, and only the
 * escape for an embedded quote differs.
 */
export type ShellFlavor = "posix" | "powershell";

/**
 * Characters safe to paste unquoted, POSIX only.
 *
 * There is no `powershell` entry: PowerShell always quotes (see
 * `quoteForShell` below), so it has no "safe to leave bare" set to define.
 * There used to be one — a `[A-Za-z0-9_@%+=:,./\\-]` character class mirroring
 * the POSIX set plus backslash — until `lib/agents/terminal-remedy.ts`'s own
 * "does this path look tame?" test proved that any such heuristic is a trap:
 * that file's OWN private safe set, historically `[A-Za-z0-9._\-/\\:]` — no
 * `@` — let a plain `C:\…\claude.cmd` through as tame while rejecting
 * `C:\…\@nagellabslibi\…` (the `@` it excluded), so two sign-in remedies that
 * both typed a path into the same PowerShell PTY took different code paths,
 * and only one of them was ever exercised before shipping. Always-quoting on
 * Windows removes the branch instead of trying to draw the character class
 * more carefully.
 *
 * The class is split into a first-character set and a rest-of-token set
 * because `%` and `=` are safe to leave bare ANYWHERE EXCEPT position 0,
 * verified in real shells:
 *
 *   $ %report.png
 *   bash: fg: no job control        # `%` as the first character of a
 *                                    # command word is a job-control spec
 *   $ printf '[%s]\n' =myfile.png
 *   zsh:1: myfile.png not found     # zsh's EQUALS expansion (on by default)
 *                                    # treats a leading `=` as `=command`
 *
 * Mid-token both are inert. A single class covering both would falsely call
 * `%report.png` or `=draft.png` "safe" — don't merge them back.
 */
const SAFE_POSIX = /^[A-Za-z0-9_@+:,./-][A-Za-z0-9_@%+=:,./-]*$/;

/**
 * One path, ready to paste. POSIX: bare when it is in the safe set, otherwise
 * single-quoted. PowerShell: always single-quoted — see the `SAFE_POSIX`
 * comment for why no character class is trusted there.
 */
export function quoteForShell(path: string, flavor: ShellFlavor): string {
  if (flavor === "posix" && SAFE_POSIX.test(path)) return path;
  const escaped =
    flavor === "powershell"
      ? path.replaceAll("'", "''")
      : path.replaceAll("'", "'\\''");
  return `'${escaped}'`;
}

/**
 * The text to paste for a set of dropped files: space-joined, each quoted only
 * if it needs to be, with a single trailing SPACE when there is any output,
 * and with NO trailing newline — the user reviews the line and presses Enter
 * themselves.
 *
 * The trailing space matches what every native terminal does on file
 * drag-drop (macOS Terminal, iTerm2, GNOME Terminal), and it is load-bearing
 * here for a second reason: this hook fires once per drop, so dropping a
 * second file right after a first one concatenates two `buildInsertText`
 * results directly in the PTY's input buffer with nothing in between. Without
 * a trailing space the two paths abut into one bogus token
 * (`shot.png/Users/...`); the trailing space keeps them separated and also
 * leaves the cursor ready for the common flow — drop an image, then type a
 * question about it. An empty path list still returns `""`, never a lone
 * space.
 */
export function buildInsertText(paths: string[], flavor: ShellFlavor): string {
  if (paths.length === 0) return "";
  return paths.map((p) => quoteForShell(p, flavor)).join(" ") + " ";
}
