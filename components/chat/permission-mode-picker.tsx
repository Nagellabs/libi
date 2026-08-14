"use client";

import { useState } from "react";
import { Shield, ShieldCheck, ShieldAlert } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  APPROVAL_MODES,
  APPROVAL_MODE_DESCRIPTIONS,
  APPROVAL_MODE_LABELS,
  DEFAULT_APPROVAL_MODE,
  type ApprovalMode,
} from "@/lib/approval/mode";
import {
  useApprovalModes,
  useUpdateApprovalMode,
} from "@/lib/queries/approval-modes";
import { useEditorState } from "@/lib/editor-state-context";

const ICON: Record<ApprovalMode, typeof Shield> = {
  ask: Shield,
  auto: ShieldCheck,
  "auto-with-generations": ShieldAlert,
};

export default function PermissionModePicker() {
  const { activeProviderId } = useEditorState();
  const { data: modes, isPending } = useApprovalModes();
  const update = useUpdateApprovalMode();
  const [error, setError] = useState<string | null>(null);

  if (!activeProviderId) return null;
  // Avoid flicker on initial load — hide the picker until the first
  // fetch resolves rather than briefly rendering the default "ask" icon.
  if (isPending) return null;

  const current = modes?.[activeProviderId] ?? DEFAULT_APPROVAL_MODE;
  const CurrentIcon = ICON[current];
  const triggerLabel = `Approval mode: ${APPROVAL_MODE_LABELS[current]}`;

  return (
    <DropdownMenu>
      <TooltipProvider delay={200}>
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex" />}>
            <DropdownMenuTrigger
              aria-label={triggerLabel}
              className="cursor-pointer flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground transition-colors outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
            >
              <CurrentIcon
                className={`h-4 w-4 ${current === "auto-with-generations" ? "text-amber-500" : ""}`}
                strokeWidth={2.2}
              />
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">{triggerLabel}</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-72"
      >
        <div className="px-2 pt-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Approval mode
        </div>
        {APPROVAL_MODES.map((mode) => {
          const Icon = ICON[mode];
          const isCurrent = mode === current;
          const isDanger = mode === "auto-with-generations";
          return (
            <DropdownMenuItem
              key={mode}
              disabled={update.isPending}
              onClick={() => {
                if (update.isPending) return;
                update.mutate(
                  { agentId: activeProviderId, mode },
                  {
                    onError: (err) =>
                      setError(
                        err instanceof Error
                          ? err.message
                          : "Failed to update mode",
                      ),
                    onSuccess: () => setError(null),
                  },
                );
              }}
              className="flex items-start gap-2 cursor-pointer py-2"
            >
              <Icon
                className={`mt-0.5 h-4 w-4 flex-shrink-0 ${isDanger ? "text-amber-500" : "text-muted-foreground"}`}
                strokeWidth={2.2}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span
                  className={`text-sm font-medium ${isDanger ? "text-amber-500" : ""}`}
                >
                  {APPROVAL_MODE_LABELS[mode]}
                  {isCurrent && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      · current
                    </span>
                  )}
                </span>
                <span className="text-xs leading-snug text-muted-foreground whitespace-normal">
                  {APPROVAL_MODE_DESCRIPTIONS[mode]}
                </span>
                {isDanger && (
                  <span className="text-xs leading-snug text-amber-500/80 whitespace-normal">
                    Real money — fal.ai and ElevenLabs calls run without
                    confirmation.
                  </span>
                )}
              </div>
            </DropdownMenuItem>
          );
        })}
        {error && (
          <div className="border-t border-border px-3 py-2 text-xs text-destructive">
            {error}
          </div>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
