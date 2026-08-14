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

/**
 * The command to type into the shell for a given preset id, or `null` to write
 * nothing (`"shell"` / unknown preset).
 */
export function launchCommandForPreset(presetId: string): string | null {
  return getPreset(presetId)?.command ?? null;
}
