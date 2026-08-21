/**
 * Resolve the command a terminal preset types into its freshly-spawned shell.
 *
 * This is just the static `preset.command` from the presets table
 * (`claude-code` → `"claude"`, `codex` → `"codex"`, `shell` → `null`, …).
 *
 * The `codex` preset used to inject libi's whole MCP set as `-c` inline
 * overrides here; that was retired. Codex now reads its MCP servers from the
 * codex home libi points it at (`CODEX_HOME` = `resolveCodexHome()`, set on the
 * PTY env in the terminal manager) — the SAME config the "Install" button in
 * "Use libi in your own tools" writes via `codex mcp add`. So a bare `codex`
 * picks up libi's tools when the user has installed them, and the giant,
 * fragile inline command line is gone.
 */

import { getPreset } from "./presets";
import { resolveUserCli } from "./user-cli";

/**
 * The command to type into the shell for a given preset id, or `null` to write
 * nothing (`"shell"` / unknown preset).
 */
export function launchCommandForPreset(presetId: string): string | null {
  return getPreset(presetId)?.command ?? null;
}

/** One line to type into the freshly-spawned shell. */
export interface TerminalLaunchLine {
  /** Written to the PTY followed by `\r`. */
  text: string;
  /** `command` = the preset's CLI. `install-hint` = a shell comment instead. */
  kind: "command" | "install-hint";
}

/**
 * Decide what to type for a preset: the CLI itself, or — when the user has no
 * such CLI — a shell COMMENT carrying the install hint.
 *
 * Why a comment rather than the command:
 *   `DEFAULT_TERMINAL_CLI_ID` is `claude-code`, so a user who has never
 *   installed Claude Code has their very first terminal greet them with
 *   `claude: command not found` and no indication of what to do about it. The
 *   preset already carries an `installHint`, but it lives in a dropdown
 *   tooltip nobody sees at that moment.
 *
 * Why a comment rather than an `echo`:
 *   The line is typed into the shell's STDIN, so whatever we write runs. A
 *   `#` comment is inert in bash, zsh and PowerShell alike (the three shells
 *   `pty.ts#resolveShell` can produce), stays visible in scrollback, and stays
 *   in history where the user can edit it into the real install command.
 *
 * Deliberately NOT pointed at libi's own bundled agent binary. That binary is
 * the Agent SDK's, driven programmatically over ACP, not the interactive
 * Claude Code CLI — and `codex-cli.ts#userCodexCli` sets the precedent that
 * when the question is "does the USER have a CLI", a hit inside libi's own
 * tree is explicitly rejected.
 */
export function launchLineForPreset(presetId: string): TerminalLaunchLine | null {
  const preset = getPreset(presetId);
  const command = preset?.command;
  if (!preset || !command) return null;

  if (resolveUserCli(command)) return { text: command, kind: "command" };

  const hint = preset.installHint
    ? `install it with: ${preset.installHint}`
    : `install it, then run: ${command}`;
  return {
    text: `# ${preset.label} isn't installed - ${hint}`,
    kind: "install-hint",
  };
}
