/**
 * Resolve the command a terminal preset types into its freshly-spawned shell.
 *
 * This is just the static `preset.command` from the presets table
 * (`claude-code` → `"claude"`, `codex` → `"codex"`, `shell` → `null`, …).
 *
 * The preset types the BARE name because the PTY runs a LOGIN shell with the
 * user's own PATH — the same lookup their own terminal would do. Whether that
 * agent is actually set up is the Agents page's question, not this module's:
 * the "Launch CLI" dropdown shows a preset whose agent is not ready as a link to
 * the Agents page (components/terminal/cli-preset-selector.tsx), so nothing here
 * probes the machine.
 *
 * Codex reads its MCP servers from the codex home libi points it at
 * (`CODEX_HOME` = `resolveCodexHome()`, set on the PTY env in the terminal
 * manager), so a bare `codex` picks up libi's tools once the user has
 * connected them.
 */

import { getPreset } from "./presets";

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
  /** Always the preset's own CLI. */
  kind: "command";
}

/** The preset's CLI as a line to type, or `null` to type nothing. */
export function launchLineForPreset(presetId: string): TerminalLaunchLine | null {
  const command = getPreset(presetId)?.command;
  return command ? { text: command, kind: "command" } : null;
}
