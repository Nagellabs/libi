"use client";

import { type ComponentType } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEditorState } from "@/lib/editor-state-context";
import { LibiMark } from "@/components/brand/libi-mark";
import {
  ClaudeLogo,
  OpenAILogo,
  TerminalLogo,
} from "@/components/brand/agent-logos";

type AgentDef = {
  id: string;
  name: string;
  /** One-line description shown under the name. */
  blurb: string;
  /** Official brand mark for the product. */
  Logo: ComponentType<{ className?: string }>;
  /** Tailwind classes for the icon tile (bg + text colour). */
  tile: string;
  /** Install hint shown when the CLI isn't detected on PATH. */
  install: string;
};

const AGENTS: AgentDef[] = [
  {
    id: "claude-code",
    name: "Claude Code",
    blurb: "Anthropic's coding agent. Best results with libi.",
    Logo: ClaudeLogo,
    tile: "bg-[#D97757]/12",
    install: "npm i -g @anthropic-ai/claude-code, then run `claude` once to sign in.",
  },
  {
    id: "codex",
    name: "Codex CLI",
    blurb: "OpenAI's coding agent. A strong alternative.",
    Logo: OpenAILogo,
    tile: "bg-white/[0.06] text-foreground",
    install: "npm i -g @openai/codex, then run `codex` once to sign in.",
  },
];

// Terminal is the universal fallback — every machine can run a shell, so it's
// always offered even when no coding-agent CLI is detected.
const TERMINAL: AgentDef = {
  id: "terminal",
  name: "Terminal",
  blurb: "Run any CLI agent in a real terminal — works on every machine.",
  Logo: TerminalLogo,
  tile: "bg-white/[0.06] text-muted-foreground",
  install: "",
};

export function OnboardingPanel() {
  const { activeProviderId, isAgentConnecting, selectAgent, agentProviders } =
    useEditorState();

  const { data: detect } = useQuery({
    queryKey: ["agent-detect"],
    queryFn: async () => (await fetch("/api/agent/detect")).json(),
  });

  const detected: Array<{ id: string; installed: boolean }> = detect?.agents ?? [];
  const installedSet = new Set(
    detected.filter((a) => a.installed).map((a) => a.id),
  );
  // Before /api/agent/detect resolves, fall back to the providers list (already
  // fetched by the context on mount) so we don't briefly flash "Not installed".
  const availableSet = new Set(
    agentProviders.filter((p) => p.available).map((p) => p.id),
  );
  const isInstalled = (id: string) =>
    detect ? installedSet.has(id) : availableSet.has(id);

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto p-8">
      <div className="flex w-full max-w-md flex-col items-center gap-8">
        {/* Logo + heading */}
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="grid size-16 place-items-center rounded-2xl bg-[color:var(--accent-soft)]">
            <LibiMark className="size-9 text-primary" />
          </div>
          <div className="flex flex-col gap-1.5">
            <h2 className="font-brand text-2xl font-semibold text-foreground">
              Connect a coding agent
            </h2>
            <p className="max-w-xs text-sm text-muted-foreground">
              libi works through a coding agent that drives your edits by chat.
              Pick one to get started.
            </p>
          </div>
        </div>

        {/* Agent cards */}
        <div className="flex w-full flex-col gap-2.5">
          {AGENTS.map((a) => (
            <AgentCard
              key={a.id}
              agent={a}
              installed={isInstalled(a.id)}
              connecting={isAgentConnecting && activeProviderId === a.id}
              onConnect={() => void selectAgent(a.id)}
            />
          ))}

          <div className="my-1 flex items-center gap-3">
            <span className="h-px flex-1 bg-border" />
            <span className="text-xs text-muted-foreground">or</span>
            <span className="h-px flex-1 bg-border" />
          </div>

          <AgentCard
            agent={TERMINAL}
            installed
            connecting={isAgentConnecting && activeProviderId === "terminal"}
            onConnect={() => void selectAgent("terminal")}
          />
        </div>
      </div>
    </div>
  );
}

function AgentCard({
  agent,
  installed,
  connecting,
  onConnect,
}: {
  agent: AgentDef;
  installed: boolean;
  connecting: boolean;
  onConnect: () => void;
}) {
  const Logo = agent.Logo;

  if (!installed) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-border/70 bg-card/40 px-4 py-3">
        <div
          className={`grid size-10 shrink-0 place-items-center rounded-lg ${agent.tile} opacity-60`}
        >
          <Logo className="size-6" />
        </div>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{agent.name}</span>
          <span className="text-xs text-muted-foreground">Not installed</span>
          {agent.install ? (
            <code className="mt-1 block whitespace-pre-wrap rounded bg-muted/60 px-1.5 py-1 text-[11px] leading-snug text-muted-foreground">
              {agent.install}
            </code>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onConnect}
      disabled={connecting}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card/60 px-4 py-3 text-left transition-colors hover:border-primary/50 hover:bg-accent disabled:cursor-default disabled:opacity-70"
    >
      <div
        className={`grid size-10 shrink-0 place-items-center rounded-lg ${agent.tile}`}
      >
        <Logo className="size-6" />
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-foreground">{agent.name}</span>
        <span className="truncate text-xs text-muted-foreground">{agent.blurb}</span>
      </div>
      <span className="ml-auto shrink-0 text-xs font-medium text-primary">
        {connecting ? <Loader2 className="size-4 animate-spin" /> : "Connect"}
      </span>
    </button>
  );
}
