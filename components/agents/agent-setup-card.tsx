"use client";

import { type ComponentType } from "react";
import { AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ClaudeLogo, OpenAILogo } from "@/components/brand/agent-logos";
import { ManualInstructionsBlock } from "@/components/agents/manual-instructions";
import type { AgentSetup } from "@/lib/agents/setup/types";
import { trackEvent } from "@/lib/analytics/client";
import { toAgentEventId, type AnalyticsSurface } from "@/lib/analytics/events";

export type AgentSetupMode = "install" | "sign-in";

export type AgentSetupState =
  | { kind: "idle" }
  | { kind: "working"; doneMb: number; totalMb: number }
  | { kind: "failed"; reason: string }
  /** An action is in flight with no measurable progress — connecting to an
   *  agent, handing a sign-in command to the terminal. Distinct from
   *  `working`, which reports real bytes. */
  | { kind: "busy"; label: string };

/** Brand tile per agent — structural chrome, not user-facing copy. Falls
 *  back to no icon for an id the registry doesn't know about yet. */
const LOGOS: Record<string, { Logo: ComponentType<{ className?: string }>; tile: string }> = {
  "claude-code": { Logo: ClaudeLogo, tile: "bg-[#D97757]/12" },
  codex: { Logo: OpenAILogo, tile: "bg-white/[0.06] text-foreground" },
};

/**
 * The ONE sign-in / install card. Claude Code and Codex render this same
 * component with different `AgentSetup` declarations — there is no second
 * layout. The manual walkthrough always sits next to the action button,
 * never behind a disclosure that starts closed.
 */
export function AgentSetupCard({
  setup,
  mode,
  state,
  surface,
  resolvedCommand,
  onStartChat,
  onAction,
  onRetry,
  onCancel,
}: {
  setup: AgentSetup;
  mode: AgentSetupMode;
  state: AgentSetupState;
  /** Where this card is rendered — reported with the funnel events so we can
   *  see which surface actually converts. */
  surface: AnalyticsSurface;
  /** The exact command libi itself would run on THIS machine — resolved from
   *  the agent's readiness remedy, and often a long absolute path (on
   *  Windows, prefixed with PowerShell's call operator). Handed to the Copy
   *  button so the clipboard carries something that actually runs; the steps
   *  still show the short form, which is readable. Falls back to the
   *  declaration's short form when no remedy has been resolved yet. */
  resolvedCommand?: string;
  /** Sign-in mode, connect screen only: connect this agent and open a chat
   *  with it right now, in libi's own chat. THE PRIMARY ACTION whenever it
   *  is present — see the comment at the buttons. Omitted on the surfaces
   *  where an auth rejection has already been OBSERVED (chat, sidebar):
   *  there, signing in is the only thing left to offer. */
  onStartChat?: () => void;
  onAction: () => void;
  onRetry: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const declaration = mode === "install" ? setup.install : setup.signIn;
  // `Object.hasOwn`, not a bare index: `LOGOS["constructor"]` is `Object` —
  // truthy, so `logo.Logo` would be undefined and React would throw "type is
  // invalid" mid-render. `setup.id` is a plain string, so nothing in the type
  // system stops that.
  const logo = Object.hasOwn(LOGOS, setup.id) ? LOGOS[setup.id] : undefined;
  const verb = mode === "install" ? "Install" : "Sign in to";
  const actionLabel = `${verb} ${setup.name}`;
  const hasAction = mode !== "install" || setup.install !== null;

  // Funnel step 6 (Task 14). `agent` is bounded via `toAgentEventId` —
  // `setup.id` is a plain string in `AgentSetup`, so an id the registry adds
  // later can never reach the event unbounded; it just silently isn't
  // reported until the analytics vocabulary is extended for it. `action`
  // reuses the same "install"/"sign-in" split the card already renders on,
  // translated to the bounded `install` | `sign_in` param.
  //
  // Step 5 (`agent_setup_started`) deliberately does NOT live here: it is
  // emitted by `useAgentSetupCardState().onAction`, which the sidebar's own
  // `InstallChip` calls too. Emitting from the card would have left every
  // sidebar install unreported while the runner still reported its
  // completion — a funnel with more completions than starts.
  const agentParam = toAgentEventId(setup.id);
  const actionParam: "install" | "sign_in" = mode === "install" ? "install" : "sign_in";

  const handleCopyCommand = () => {
    if (agentParam) {
      trackEvent("agent_setup_command_copied", { agent: agentParam, action: actionParam });
    }
  };

  return (
    <div
      data-slot="agent-setup-card"
      data-surface={surface}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card/60 p-4"
    >
      <div className="flex items-start gap-3">
        {logo ? (
          <div className={`grid size-10 shrink-0 place-items-center rounded-lg ${logo.tile}`}>
            <logo.Logo className="size-6" />
          </div>
        ) : null}
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium text-foreground">{setup.name}</span>
          <span className="text-xs text-muted-foreground">{setup.blurb}</span>
        </div>
      </div>

      {!hasAction ? null : state.kind === "working" ? (
        <ProgressSection doneMb={state.doneMb} totalMb={state.totalMb} onCancel={onCancel} />
      ) : state.kind === "failed" ? (
        <FailureSection reason={state.reason} onRetry={onRetry} />
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {/* WHICH of these leads is a statement about what libi knows. No
              cheap check can tell us whether an agent is signed in — Claude
              Code answers `session/new` with no credentials at all — and on
              this screen nothing has been tried yet. Most machines that have
              a coding-agent CLI are already signed into it, so the majority
              case leads: start chatting, and sign in only if that turns out
              to be needed. This used to be inverted, with the way through for
              the signed-in user reduced to a grey underlined link.

              On the surfaces where an auth rejection HAS been observed (chat,
              sidebar) `onStartChat` is absent, and signing in is again the
              whole offer — as it should be, because there we know. */}
          <Button
            type="button"
            className="cursor-pointer"
            onClick={onStartChat ?? onAction}
            disabled={state.kind === "busy"}
          >
            {state.kind === "busy"
              ? state.label
              : onStartChat
                ? "Start chat"
                : actionLabel}
          </Button>
          {onStartChat ? (
            <>
              {/* Spelled out, because the two buttons are genuinely two
                  routes rather than an action and its modifier — and which
                  one you want depends on something libi cannot see (whether
                  you are already signed in). Side by side with nothing
                  between them, the second reads as a qualifier on the
                  first. */}
              <span className="px-0.5 text-sm font-semibold uppercase tracking-wider text-muted-foreground">
                or
              </span>
              <Button
                type="button"
                variant="outline"
                className="cursor-pointer"
                onClick={onAction}
                disabled={state.kind === "busy"}
              >
                {actionLabel}
              </Button>
            </>
          ) : null}
          {mode === "install" && setup.install ? (
            <span className="text-xs text-muted-foreground">{setup.install.sizeLabel}</span>
          ) : null}
        </div>
      )}

      {hasAction && declaration ? (
        <ManualInstructionsBlock
          steps={declaration.manual}
          copyCommand={
            resolvedCommand ??
            (mode === "install" ? setup.install!.command : setup.signIn.displayCommand)
          }
          onCopy={handleCopyCommand}
        />
      ) : null}
    </div>
  );
}

function ProgressSection({
  doneMb,
  totalMb,
  onCancel,
}: {
  doneMb: number;
  totalMb: number;
  onCancel: () => void;
}) {
  const pct = totalMb > 0 ? Math.min(100, Math.round((doneMb / totalMb) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="progressbar"
        aria-valuenow={doneMb}
        aria-valuemin={0}
        aria-valuemax={totalMb}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          {doneMb} / {totalMb} MB
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function FailureSection({ reason, onRetry }: { reason: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3">
      <div className="flex items-start gap-2">
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <span className="text-xs text-destructive">{reason}</span>
      </div>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="cursor-pointer self-start"
        onClick={onRetry}
      >
        Retry
      </Button>
    </div>
  );
}
