"use client";

import { useId } from "react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { isSetupAgentId, SETUP_AGENTS, setupAgentName } from "@/lib/agents/setup/registry";
import type { SetupTerminalEntry } from "@/components/agents-page/setup-terminal-host";

/**
 * One option of the switch. Selected: the app's primary tint, outlined, in
 * medium weight — which agent the tab is about can't be missed. Not selected:
 * muted text that brightens over a hover background, so it reads as the other
 * choice. Keyboard focus keeps the tabs primitive's ring.
 */
const OPTION_CLASS = [
  // text-foreground/70, not text-muted-foreground: in light mode the token
  // alone read at about 3.2:1 for this 14px text, short of WCAG AA.
  "group/agent-option h-8 flex-none gap-2 px-3 font-normal text-foreground/70",
  "not-data-active:hover:bg-foreground/10 not-data-active:hover:text-foreground",
  "data-active:border-primary/50 data-active:bg-primary/15 data-active:font-medium data-active:text-foreground",
  "dark:data-active:border-primary/50 dark:data-active:bg-primary/15",
].join(" ");

/**
 * The Claude Code | Codex switch at the top of a setup tab: a labelled tablist
 * in the segmented look — not the page tabs' line, so it can't be mistaken for
 * them — whose panel is what the tab shows for the selected agent. Arrow keys
 * move between the options and switch.
 *
 * Everything under the switch goes in `children`; the part that is about the
 * selected agent goes in an `AgentSwitchPanel`, so the tablist has its panel.
 * `hints` puts a short muted line beside an option's name (Providers: "1 connected").
 * Test ids: `<testIdPrefix>-agent-switch`, `<testIdPrefix>-agent-option-<agentId>`.
 */
export function AgentSwitch({
  label,
  value,
  onValueChange,
  hints,
  testIdPrefix,
  children,
}: {
  label: string;
  value: SetupAgentId;
  onValueChange: (next: SetupAgentId) => void;
  hints?: Partial<Record<SetupAgentId, string>>;
  testIdPrefix: string;
  children: React.ReactNode;
}) {
  const labelId = useId();
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string" && isSetupAgentId(next)) onValueChange(next);
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span id={labelId} className="text-sm text-muted-foreground">
          {label}
        </span>
        <TabsList
          data-testid={`${testIdPrefix}-agent-switch`}
          aria-labelledby={labelId}
          activateOnFocus
          className="h-auto gap-1 border border-border p-1"
        >
          {SETUP_AGENTS.map((agent) => {
            const hint = hints?.[agent.id];
            return (
              <TabsTrigger
                key={agent.id}
                value={agent.id}
                data-testid={`${testIdPrefix}-agent-option-${agent.id}`}
                className={OPTION_CLASS}
              >
                {agent.name}
                {/* The space keeps the name and the hint apart when read out: "Codex 1 connected". */}
                {hint ? (
                  <>
                    {" "}
                    <span className="text-xs font-normal text-muted-foreground group-data-active/agent-option:text-foreground/75">
                      {hint}
                    </span>
                  </>
                ) : null}
              </TabsTrigger>
            );
          })}
        </TabsList>
      </div>
      {children}
    </Tabs>
  );
}

/** What a setup tab shows for the selected agent: the switch's tabpanel. Pass the switch's `value`. */
export function AgentSwitchPanel({
  value,
  className,
  children,
}: {
  value: SetupAgentId;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <TabsContent value={value} className={className}>
      {children}
    </TabsContent>
  );
}

/** Where a setup terminal is: its command still open, finished, or closed by the server for idling. */
export type SetupTerminalState = "live" | "exited" | "gone";

/** In the terminal's own order: a command that finished says so even after the server closed its terminal. */
export function setupTerminalState(entry: Pick<SetupTerminalEntry, "exited" | "gone">): SetupTerminalState {
  if (entry.exited) return "exited";
  return entry.gone ? "gone" : "live";
}

const NOTICE_TEXT: Record<SetupTerminalState, (name: string) => string> = {
  live: (name) => `${name} has a setup command open.`,
  exited: (name) => `${name}'s setup command finished.`,
  gone: (name) => `${name}'s setup terminal was closed.`,
};

/**
 * The line a setup tab shows where its content starts when its one setup
 * terminal belongs to the agent that isn't selected: switching agent hides the
 * terminal, so this is the way back to it — and to its Close, which is why the
 * line stays after the command has finished or the terminal was closed for idling.
 */
export function OtherAgentTerminalNotice({
  agentId,
  state,
  onShow,
  testId,
}: {
  /** The agent the terminal belongs to. */
  agentId: SetupAgentId;
  state: SetupTerminalState;
  onShow: () => void;
  testId: string;
}) {
  const name = setupAgentName(agentId);
  return (
    <div
      data-testid={testId}
      className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-sm text-foreground"
    >
      <span>{NOTICE_TEXT[state](name)}</span>
      <Button variant="outline" size="sm" className="cursor-pointer" onClick={onShow}>
        Show {name}
      </Button>
    </div>
  );
}
