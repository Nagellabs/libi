"use client";

import Link from "next/link";
import { ChevronDown, SquareTerminal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
} from "@/components/ui/dropdown-menu";
import { useEditorState } from "@/lib/editor-state-context";
import { agentSetupHref } from "@/lib/agents/setup/registry";
import {
  TERMINAL_CLI_PRESETS,
  getPreset,
  type TerminalCliPreset,
} from "@/lib/terminal/presets";
import { usePresetReadiness } from "./use-preset-readiness";

/**
 * "Launch CLI" dropdown — visible under the agent selector while the
 * Terminal surface is active. Controls what a NEW terminal auto-runs;
 * existing terminals are untouched.
 *
 * We only surface the tested presets (Shell / Claude Code / Codex). Any
 * other CLI agent is still usable — pick "Shell" and run it by hand.
 *
 * A preset whose agent is not ready (`usePresetReadiness`) is a link to that
 * agent's setup on the Agents page, with "Set up in Agents" in place of its
 * command, instead of an item that selects a command the shell can't run.
 * The SELECTED preset gets the same treatment on the trigger: it is what the
 * "New terminal" buttons launch — Claude Code by default — so a not-ready
 * selection says "Set up in Agents" without the menu being opened.
 */
export default function CliPresetSelector() {
  const { terminalCliId, setTerminalCliId } = useEditorState();
  const { isNotReady } = usePresetReadiness();
  const selected = getPreset(terminalCliId) ?? getPreset("shell")!;
  const selectedNotReady = isNotReady(selected.id);

  const renderItem = (preset: TerminalCliPreset) => {
    const notReady = isNotReady(preset.id);
    const content = (
      <>
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            terminalCliId === preset.id && !notReady
              ? "bg-emerald-500"
              : "bg-muted-foreground/30"
          }`}
        />
        <span className={`flex-1 ${notReady ? "text-muted-foreground" : ""}`}>
          {preset.label}
        </span>
        {notReady ? (
          <span className="text-[10px] font-medium text-primary">Set up in Agents</span>
        ) : preset.command ? (
          <span className="font-mono text-[10px] text-muted-foreground">
            {preset.command}
          </span>
        ) : null}
      </>
    );
    const className =
      "gap-2 cursor-pointer transition-colors data-highlighted:!bg-foreground/10";
    return notReady ? (
      <DropdownMenuLinkItem
        key={preset.id}
        data-not-ready
        render={<Link href={agentSetupHref(preset.id)} />}
        closeOnClick
        className={className}
      >
        {content}
      </DropdownMenuLinkItem>
    ) : (
      <DropdownMenuItem
        key={preset.id}
        onClick={() => setTerminalCliId(preset.id)}
        className={className}
      >
        {content}
      </DropdownMenuItem>
    );
  };

  return (
    <div className="flex w-full items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger className="cursor-pointer flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs transition-colors outline-none hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50">
          <SquareTerminal className="h-3 w-3 flex-shrink-0 text-muted-foreground" />
          <span
            className={`truncate max-w-[160px] ${
              selectedNotReady ? "text-muted-foreground" : "text-foreground"
            }`}
          >
            {selected.label}
          </span>
          <ChevronDown className="ml-auto h-3 w-3 flex-shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>

        <DropdownMenuContent align="end" sideOffset={6} className="min-w-[220px]">
          {TERMINAL_CLI_PRESETS.map(renderItem)}
        </DropdownMenuContent>
      </DropdownMenu>
      {selectedNotReady ? (
        <Link
          href={agentSetupHref(selected.id)}
          className="shrink-0 cursor-pointer text-[10px] font-medium text-primary underline-offset-4 hover:underline"
        >
          Set up in Agents
        </Link>
      ) : null}
    </div>
  );
}
