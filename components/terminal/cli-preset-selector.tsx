"use client";

import { ChevronDown, SquareTerminal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useEditorState } from "@/lib/editor-state-context";
import {
  TERMINAL_CLI_PRESETS,
  getPreset,
  type TerminalCliPreset,
} from "@/lib/terminal/presets";

/**
 * "Launch CLI" dropdown — visible under the agent selector while the
 * Terminal surface is active. Controls what a NEW terminal auto-runs;
 * existing terminals are untouched.
 *
 * We only surface the tested presets (Shell / Claude Code / Codex). Any
 * other CLI agent is still usable — pick "Shell" and run it by hand.
 */
export default function CliPresetSelector() {
  const { terminalCliId, setTerminalCliId } = useEditorState();
  const selected = getPreset(terminalCliId) ?? getPreset("shell")!;

  const renderItem = (preset: TerminalCliPreset) => (
    <DropdownMenuItem
      key={preset.id}
      onClick={() => setTerminalCliId(preset.id)}
      className="gap-2 cursor-pointer transition-colors data-highlighted:!bg-foreground/10"
      title={preset.installHint ?? undefined}
    >
      <span
        className={`inline-block h-1.5 w-1.5 rounded-full ${
          terminalCliId === preset.id
            ? "bg-emerald-500"
            : "bg-muted-foreground/30"
        }`}
      />
      <span className="flex-1">{preset.label}</span>
      {preset.command ? (
        <span className="font-mono text-[10px] text-muted-foreground">
          {preset.command}
        </span>
      ) : null}
    </DropdownMenuItem>
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="cursor-pointer flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs transition-colors outline-none hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50">
        <SquareTerminal className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
        <span className="truncate max-w-[160px] text-foreground">
          {selected.label}
        </span>
        <ChevronDown className="ml-auto h-3 w-3 flex-shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[220px]">
        {TERMINAL_CLI_PRESETS.map(renderItem)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
