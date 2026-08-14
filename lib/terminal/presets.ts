/**
 * CLI launch presets for terminal sessions.
 *
 * Shared by the "Launch CLI" dropdown (client) and the TerminalManager
 * (server), which types the preset's command into the freshly-spawned
 * shell. The command is TYPED (written to the PTY + "\r"), not exec'd —
 * when the CLI exits the user keeps a live shell, and the command stays
 * visible/editable in shell history.
 *
 * We deliberately expose ONLY the presets we've actually tested end-to-end
 * inside libi: Shell, Claude Code, and Codex. Any other CLI agent is still
 * fully usable — the user picks "Shell" and runs whatever they want. We
 * don't advertise untested agents as first-class options.
 */

export interface TerminalCliPreset {
  id: string;
  /** Human label shown in the dropdown + used as the default session title. */
  label: string;
  /** Command typed into the shell on session start. Null = plain shell. */
  command: string | null;
  /** Shown as a tooltip so the user knows how to install a missing CLI. */
  installHint: string | null;
}

export const TERMINAL_CLI_PRESETS: TerminalCliPreset[] = [
  // Label is just "Shell" — the user may launch any agent manually, so
  // "(no agent)" would be misleading as the session title.
  { id: "shell", label: "Shell", command: null, installHint: null },
  {
    id: "claude-code",
    label: "Claude Code",
    command: "claude",
    installHint: "npm i -g @anthropic-ai/claude-code",
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    installHint: "npm i -g @openai/codex",
  },
];

export const DEFAULT_TERMINAL_CLI_ID = "claude-code";

export function getPreset(id: string): TerminalCliPreset | undefined {
  return TERMINAL_CLI_PRESETS.find((p) => p.id === id);
}
