/**
 * How a user fixes an unusable agent, expressed as a command for libi's OWN
 * built-in Terminal.
 *
 * Why the Terminal and not a server-side spawn: signing in is interactive. It
 * opens a browser, prints a device code, waits on a paste. libi's Terminal
 * surface already exists for exactly this (real PTY, login shell, command TYPED
 * rather than exec'd so the user keeps a live shell afterwards) — see
 * lib/terminal/presets.ts. The server never runs these.
 *
 * The non-obvious part, and the reason this module exists at all:
 *
 *   SIGNING IN TO CODEX REQUIRES NO INSTALL.
 *
 * libi bundles the codex engine (@openai/codex-<platform>-<arch>, ~271MB,
 * verified running on a machine with no `codex` on PATH). So the remedy for
 * "Codex needs to be signed in" is to run libi's OWN binary with `login` —
 * not to send the user off to `npm i -g @openai/codex`. Telling them to install
 * something they already have, to fix a problem installing does not fix, is the
 * wrong instruction twice over.
 *
 * Installing the CLI is a genuinely separate remedy, needed only for the
 * "use libi in your own tools" flow, which shells out to the USER's `codex`.
 */
import { isWindows } from "@/lib/platform";
import { quoteForShell } from "@/lib/terminal/shell-quote";
import { resolveCodexNativeBinary } from "./codex-native-binary";

export interface TerminalRemedy {
  /** Button text. Imperative, names the outcome ("Sign in to Codex"). */
  label: string;
  /** Typed into the Terminal's login shell verbatim. */
  command: string;
  /** One line explaining what the command will do, shown next to the button. */
  detail: string;
}

/**
 * A line that RUNS `bin` with `args` when typed into that shell.
 *
 * The Windows half is the whole point. PowerShell parses a statement that
 * begins with a quoted string as an EXPRESSION, not a command: it evaluates
 * to the string. So `'C:\…\codex.exe' login` is a parse error —
 *
 *     Unexpected token 'login' in expression or statement.
 *
 * — which is exactly what the "Sign in to Codex" button produced on Windows,
 * and `'C:\…\claude.cmd'` on its own is worse, because PowerShell simply
 * ECHOES the path and exits 0. Nothing runs, nothing complains.
 *
 * `&`, the call operator, is what tells PowerShell to treat the string as a
 * command to invoke. Verified on the QA box against the real bundled engine:
 * the quoted form errors, `& '<path>' --version` prints `codex-cli 0.148.0`.
 *
 * Bare command NAMES (`claude`, `npm`) are not paths and never take this
 * treatment — they resolve through PATH in both shells as they are.
 *
 * The quoting itself comes from `lib/terminal/shell-quote.ts#quoteForShell` —
 * the same pure function `hooks/terminal/use-terminal-file-drop.ts` uses for
 * dropped paths, so there is exactly one PowerShell-vs-POSIX quoting policy
 * for the one PTY both callers type into. See the `SAFE` comment there for
 * why PowerShell always quotes rather than trying to detect a "safe" path:
 * that heuristic is what let this exact bug ship in the first place (a plain
 * `C:\…\claude.cmd` read as tame, `C:\…\@nagellabslibi\…` did not, so only one
 * of the two remedies below ever ran the always-quote branch before this).
 */
function runBinaryLine(bin: string, ...args: string[]): string {
  const line = [quoteForShell(bin, isWindows() ? "powershell" : "posix"), ...args].join(" ");
  return isWindows() ? `& ${line}` : line;
}

/**
 * Sign in to Codex using the engine libi already ships.
 *
 * `root` is the tree the adapter resolved from (`detectCodex`'s `codexRoot`).
 * Returns null when no bundled engine is present — in that case the agent would
 * have reported `not-installed`, so there is no auth remedy to offer.
 */
export function codexSignInRemedy(root: string | null): TerminalRemedy | null {
  if (!root) return null;
  const bin = resolveCodexNativeBinary(root);
  if (!bin) return null;
  return {
    label: "Sign in to Codex",
    command: runBinaryLine(bin, "login"),
    detail: "Runs the Codex engine libi already ships — nothing to install.",
  };
}

/**
 * Sign in to Claude Code.
 *
 * Claude's CLI drives its own interactive login, so the remedy is simply to run
 * it.
 *
 * `bin` MUST be the Claude **CLI** libi downloaded — NOT the ACP adapter.
 * Running `claude-agent-acp` starts an ACP stdio server that sits waiting on a
 * JSON-RPC handshake; it performs no login and, typed into a terminal, just
 * appears to hang. Resolve it the way the engine is resolved, not the way the
 * adapter is.
 *
 * Falling back to the bare name `claude` is legitimate here where it would not
 * be on the server: the Terminal runs a LOGIN shell, so it has the user's real
 * PATH — the very thing the server process lacks (and the confusion that caused
 * the codex-shim bug; see lib/codex-config/codex-cli.ts).
 */
export function claudeSignInRemedy(bin: string | null): TerminalRemedy {
  return {
    label: "Sign in to Claude Code",
    command: bin ? runBinaryLine(bin) : "claude",
    detail: "Opens Claude Code's own sign-in flow in a terminal.",
  };
}

/**
 * Install the Codex CLI into the USER's environment.
 *
 * Only for the "use libi in your own tools" integration — libi's in-app chat
 * never needs this. Offered when a login-shell PATH probe finds no codex that
 * belongs to the user (see lib/codex-config/codex-cli.ts).
 */
export function codexInstallRemedy(): TerminalRemedy {
  // `detail` sits directly under the section's own one-liner, so it says only
  // what that line can't: the command itself. Repeating the rationale here is
  // how the copy grew long enough that nobody read any of it.
  return {
    label: "Install the Codex CLI",
    command: "npm i -g @openai/codex",
    detail: "Runs in libi's terminal.",
  };
}
