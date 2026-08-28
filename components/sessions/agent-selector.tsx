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
import { getAgentSetup } from "@/lib/agents/setup/registry";
import { useAgentSetupCardState } from "@/hooks/agents/use-agent-setup-card-state";
import type { AgentSetupState } from "@/components/agents/agent-setup-card";

const UNKNOWN_READINESS: AgentReadiness = { state: "unknown" };

/**
 * The Install (or Retry) affordance for a `not-installed` row that declares
 * an install step.
 *
 * DELIBERATELY NOT the shared `AgentSetupCard`: a dropdown row is a genuinely
 * different rendering — no room for a blurb, a manual walkthrough, or a
 * failure sentence (the row already gave up its own sentence to make space
 * for this). What IS shared is the state it renders, derived once in
 * `useAgentSetupCardState` — the same `agent_install` job the connect-agent
 * card and the chat drive, reaching the same conclusions about it.
 *
 * The failure reason has nowhere to render at this size, so it goes on the
 * button's `title` rather than being dropped entirely — a 500 from the POST
 * used to be invisible everywhere.
 */
function InstallChip({
  state,
  onInstall,
  onCancel,
}: {
  state: AgentSetupState;
  onInstall: () => void;
  onCancel: () => void;
}) {
  if (state.kind === "working") {
    const pct =
      state.totalMb > 0
        ? Math.min(100, Math.round((state.doneMb / state.totalMb) * 100))
        : 0;
    return (
      <span className="mt-1 flex w-full flex-col gap-1">
        <span
          role="progressbar"
          aria-valuenow={state.doneMb}
          aria-valuemin={0}
          aria-valuemax={state.totalMb}
          className="block h-1 w-full overflow-hidden rounded-full bg-muted"
        >
          <span
            className="block h-full rounded-full bg-primary transition-[width]"
            style={{ width: `${pct}%` }}
          />
        </span>
        <span className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground">
            {state.doneMb} / {state.totalMb} MB
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            className="cursor-pointer text-[10px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          >
            Cancel
          </button>
        </span>
      </span>
    );
  }

  // A cancel is not a failure, and a failure isn't a reason to hide the
  // action — same conclusion the card reaches, condensed to a label since
  // there's no room for the reason text here.
  const label =
    state.kind === "busy" ? state.label : state.kind === "failed" ? "Retry" : "Install";

  return (
    <button
      type="button"
      disabled={state.kind === "busy"}
      title={state.kind === "failed" ? state.reason : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onInstall();
      }}
      className="mt-1 w-fit cursor-pointer rounded-md bg-primary px-2 py-0.5 text-[10px] font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-70"
    >
      {label}
    </button>
  );
}

/**
 * An unavailable agent is rendered DISABLED WITH ITS REASON rather than
 * omitted. Claude Code's adapter is installed at runtime (~306MB), so on a
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
 *
 * A THIRD case (Task 10): unavailable AND the agent declares an install step
 * (lib/agents/setup/registry.ts). That used to render the SAME disabled
 * sentence as any other unavailable agent — a dead end nobody could act on.
 * When there's an install to offer, this row instead renders an Install (or
 * Retry) chip wired to the real `agent_install` job, and drops the sentence
 * entirely so the old "restart libi…" copy never renders. `installing` (the
 * automatic boot-time install already in flight) and Codex (`install: null`
 * — libi ships its engine, offering to install it would be the bug this
 * project already had once) both keep the plain disabled-with-reason row.
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
  const declaresInstall = getAgentSetup(provider.id)?.install != null;
  const offerInstall = !provider.available && !installing && Boolean(reason) && declaresInstall;
  const subtitle = reason?.message ?? (needsAuth ? readinessMessage(readiness) : null);

  // Shared with the connect-agent card and the chat: same job, same
  // conclusions about it, same push of a completed install back into
  // `agentProviders` (which isn't React Query, so nothing else would) — and
  // the same `agent_setup_started` emit, which this surface used to skip
  // entirely because it renders its own chip instead of the card.
  const { state, onAction, onCancel } = useAgentSetupCardState(
    offerInstall ? provider.id : null,
    "install",
    { surface: "sidebar" },
  );

  // An install-offering row keeps its "can't select it yet" disposition but
  // must NOT carry base-ui's `disabled` — that applies `pointer-events-none`
  // to the whole item, which would swallow clicks on the Install/Cancel
  // buttons nested inside it.
  const rowDisabled = !provider.available && !offerInstall;

  return (
    <DropdownMenuItem
      disabled={rowDisabled}
      // Losing `disabled` on an install-offering row also loses base-ui's
      // disabled-guard around the ROW's own click handler, and
      // `closeOnClick` defaults to true — so a click anywhere on the row
      // body (missing the nested Install/Cancel button by a few pixels)
      // would close the whole dropdown instead of doing nothing, same as
      // it always has for a row that isn't selectable yet.
      closeOnClick={!offerInstall}
      onClick={provider.available ? onSelect : undefined}
      title={reason?.detail ?? (needsAuth ? readiness.remedy?.detail : undefined)}
      className={`gap-2 transition-colors data-highlighted:!bg-foreground/10 ${
        provider.available ? "cursor-pointer" : "cursor-not-allowed"
      } ${subtitle || offerInstall ? "items-start" : ""}`}
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
        {offerInstall ? (
          <InstallChip state={state} onInstall={onAction} onCancel={onCancel} />
        ) : subtitle ? (
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
    setRightRegionMode,
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
            onSelect={() => {
              // Choosing an agent here is also a way out of the connect
              // takeover — the screen exists to get you to exactly this.
              setRightRegionMode("editor");
              return selectAgent(p.id);
            }}
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
