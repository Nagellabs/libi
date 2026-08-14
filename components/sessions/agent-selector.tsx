"use client";

import { ChevronDown, Loader2, RotateCw } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useEditorState, type ProviderInfo } from "@/lib/editor-state-context";
import {
  readinessMessage,
  type AgentReadiness,
} from "@/lib/agents/agent-readiness";

const UNKNOWN_READINESS: AgentReadiness = { state: "unknown" };

/**
 * An unavailable agent is rendered DISABLED WITH ITS REASON rather than
 * omitted. Claude Code's adapter is installed at runtime (~212MB), so on a
 * first boot the default agent is legitimately unavailable for minutes —
 * dropping the row leaves the user staring at a list it silently vanished
 * from, with the explanation only in ~/.libi/logs/libi.log.
 *
 * `available` and READINESS answer different questions and are rendered
 * differently on purpose. Codex ships its engine inside libi, so it is
 * `available: true` on every machine — and still unusable until the user signs
 * in. That second fact arrives later (from an observed `session/new` rejection)
 * and shows as a "Sign-in required" badge on a row that stays SELECTABLE:
 * selecting it is how the user reaches the remedy.
 */
function AgentRow({
  provider,
  active,
  readiness,
  onSelect,
}: {
  provider: ProviderInfo;
  active: boolean;
  readiness: AgentReadiness;
  onSelect: () => void;
}) {
  const reason = provider.available ? undefined : provider.unavailableReason;
  const installing = reason?.code === "installing";
  const needsAuth = provider.available && readiness.state === "needs-auth";
  const subtitle = reason?.message ?? (needsAuth ? readinessMessage(readiness) : null);

  return (
    <DropdownMenuItem
      disabled={!provider.available}
      onClick={provider.available ? onSelect : undefined}
      title={reason?.detail ?? (needsAuth ? readiness.remedy?.detail : undefined)}
      className={`gap-2 transition-colors data-highlighted:!bg-foreground/10 ${
        provider.available ? "cursor-pointer" : "cursor-not-allowed"
      } ${subtitle ? "items-start" : ""}`}
    >
      {installing ? (
        <Loader2 className="mt-[3px] h-1.5 w-1.5 shrink-0 animate-spin text-amber-400" />
      ) : (
        <span
          className={`mt-[7px] inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
            needsAuth
              ? "bg-amber-400"
              : active
                ? "bg-emerald-500"
                : "bg-muted-foreground/30"
          }`}
        />
      )}
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-1.5">
          <span className="truncate">{provider.name}</span>
          {needsAuth ? (
            <span className="shrink-0 rounded-full bg-amber-400/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-500">
              Sign-in required
            </span>
          ) : null}
        </span>
        {subtitle ? (
          <span className="text-xs leading-snug text-wrap text-muted-foreground">
            {subtitle}
          </span>
        ) : null}
      </span>
    </DropdownMenuItem>
  );
}

export default function AgentSelector() {
  const {
    agentProviders: providers,
    activeProviderId,
    isAgentConnecting: isConnecting,
    selectAgent,
    refreshAgentProviders,
    sessionList,
  } = useEditorState();

  // Tolerate a context that predates readiness (and the mocked contexts in
  // older component tests) rather than crashing the whole selector.
  const readinessFor = sessionList?.readinessFor;
  const activeReadiness: AgentReadiness =
    sessionList?.readiness ?? UNKNOWN_READINESS;

  const dotClass = (() => {
    if (isConnecting) return "bg-amber-400 animate-pulse";
    // Green is a claim that the agent works. It used to be made purely because
    // `_activeAgentId` had been assigned — true even for an agent whose every
    // session/new is rejected. Now an observed failure downgrades it.
    if (activeReadiness.state === "needs-auth") return "bg-amber-400";
    if (activeReadiness.state === "not-installed") return "bg-destructive";
    if (activeProviderId) return "bg-emerald-500";
    return "bg-muted-foreground/40";
  })();

  const label = (() => {
    if (activeProviderId) {
      const prov = providers.find((p) => p.id === activeProviderId);
      return prov?.name ?? "Select agent";
    }
    return "Select agent";
  })();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        title={readinessMessage(activeReadiness) ?? undefined}
        className="cursor-pointer flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs transition-colors outline-none hover:border-foreground/20 focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
      >
        <span className={`inline-block h-2 w-2 flex-shrink-0 rounded-full transition-colors ${dotClass}`} />
        <span className="truncate max-w-[160px] text-foreground">{label}</span>
        <ChevronDown className="ml-auto h-3 w-3 flex-shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" sideOffset={6} className="min-w-[200px]">
        {providers.map((p) => (
          <AgentRow
            key={p.id}
            provider={p}
            active={activeProviderId === p.id}
            readiness={readinessFor?.(p.id) ?? UNKNOWN_READINESS}
            onSelect={() => selectAgent(p.id)}
          />
        ))}

        <DropdownMenuSeparator />

        <DropdownMenuItem onClick={() => refreshAgentProviders()} className="gap-2 cursor-pointer transition-colors data-highlighted:!bg-foreground/10">
          <RotateCw className="h-3 w-3" />
          Re-detect agents
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
