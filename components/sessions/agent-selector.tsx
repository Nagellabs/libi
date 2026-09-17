"use client";

import Link from "next/link";
import { Bot, ChevronDown, Loader2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLinkItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { useEditorState, type ProviderInfo } from "@/lib/editor-state-context";
import {
  readinessMessage,
  type AgentReadiness,
} from "@/lib/agents/agent-readiness";
import { agentSetupHref } from "@/lib/agents/setup/registry";

const UNKNOWN_READINESS: AgentReadiness = { state: "unknown" };

/**
 * An unavailable agent is rendered DISABLED WITH ITS REASON rather than
 * omitted: dropping the row leaves the user staring at a list it silently
 * vanished from, with the explanation only in ~/.libi/logs/libi.log.
 *
 * `available` and READINESS answer different questions and are rendered
 * differently on purpose. An installed agent is `available: true` — and still
 * unusable until the user signs in. That second fact arrives later (from an
 * observed auth rejection) and shows as a "Sign-in required" badge on a row
 * that stays SELECTABLE.
 *
 * Either way a not-ready row says ONE line — the server's own reason — and is
 * followed by a "Set up in Agents" link to that agent's setup. Setup happens
 * on the Agents page, never inside this menu. The link is its own menu item
 * because a disabled item swallows pointer events for everything inside it.
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
  const notReady = !provider.available || needsAuth;

  return (
    <>
      <DropdownMenuItem
        disabled={!provider.available}
        onClick={provider.available ? onSelect : undefined}
        title={reason?.detail}
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
      {notReady ? (
        <DropdownMenuLinkItem
          render={<Link href={agentSetupHref(provider.id)} />}
          closeOnClick
          className="ml-3.5 w-fit text-xs font-medium text-primary underline-offset-4 hover:underline data-highlighted:!bg-foreground/10"
        >
          Set up in Agents
        </DropdownMenuLinkItem>
      ) : null}
    </>
  );
}

export default function AgentSelector() {
  const {
    agentProviders: providers,
    activeProviderId,
    isAgentConnecting: isConnecting,
    selectAgent,
    reloadAgentProviders,
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
    // The list is read again every time the menu opens, so an agent set up on
    // the Agents page shows here without a reload. Detection itself is kept
    // current by the Agents page and by agent installs — there is nothing for
    // the user to re-run from this menu.
    <DropdownMenu onOpenChange={(open) => { if (open) reloadAgentProviders(); }}>
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

        <DropdownMenuLinkItem
          render={<Link href={agentSetupHref()} />}
          closeOnClick
          className="gap-2 cursor-pointer transition-colors data-highlighted:!bg-foreground/10"
        >
          <Bot className="h-3 w-3" />
          Manage agents
        </DropdownMenuLinkItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
