/**
 * The lines libi's setup scripts print around Claude Code's `mcp login`, and the reader that finds them in a setup
 * terminal's output. Claude Code must not be asked about an entry while its sign-in may be running
 * (`./claude-signin-probe.ts` has the hazard), and the shell stays open after the command, so the terminal's exit
 * says nothing about the sign-in having ended. The scripts say it instead:
 *
 *   [libi sign-in start: <entry>]     before the add (add-provider) or the login (signin-provider)
 *   [libi sign-in end: <entry>]       when it has ended, however: done, failed, or stopped with Ctrl-C
 *
 * Plain text, not an escape sequence: Windows' ConPTY rewrites the output it passes on, and a line of text is what
 * reliably reaches libi from both platforms. The reader strips the escape sequences a terminal may put between the
 * characters (colour, cursor moves), and keeps a short tail so a line split across two output chunks is still
 * found. An entry name holding `]` or a line break (a name the user chose; libi's own adds use the catalog's) is
 * not found: its sign-in is then neither held back nor re-asked until its terminal goes away.
 */

export type SignInMarker = { phase: "start" | "end"; entry: string };

const MARKER = /\[libi sign-in (start|end): ([^\]\r\n]{1,200})\]/g;
/**
 * CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC \`), and any other two-byte escape — never `ESC [` or `ESC ]`
 * alone, which is the start of one of the first two split across chunks and is kept until its end arrives.
 */
const ESCAPES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\^_]/g;
/** Kept between chunks: a marker is shorter than this. */
const TAIL = 512;

/** The two lines, as the scripts print them (tests and the scripts' own checks use these). */
export function signInMarkerLine(phase: SignInMarker["phase"], entry: string): string {
  return `[libi sign-in ${phase}: ${entry}]`;
}

/** A reader for one terminal's output: feed it every chunk, get back the markers completed by that chunk, in order. */
export function createSignInMarkerReader(): (chunk: string) => SignInMarker[] {
  let pending = "";
  return (chunk) => {
    const text = (pending + chunk).replace(ESCAPES, "");
    const found: SignInMarker[] = [];
    let consumed = 0;
    for (const m of text.matchAll(MARKER)) {
      found.push({ phase: m[1] as SignInMarker["phase"], entry: m[2] });
      consumed = (m.index ?? 0) + m[0].length;
    }
    // Keep only what could still be the start of a marker: after the last one found, at most the tail.
    const rest = text.slice(consumed);
    pending = rest.length > TAIL ? rest.slice(rest.length - TAIL) : rest;
    return found;
  };
}
