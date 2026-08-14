"use client";

import { useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu";
import { useSessionModel, useSetSessionModel } from "@/lib/queries/session-model";
import { modelDisplayLabel } from "@/lib/sessions/model-option";

export default function ModelPicker({ sessionId }: { sessionId: string | null }) {
  const { data, isPending } = useSessionModel(sessionId);
  const setModel = useSetSessionModel(sessionId);
  const [error, setError] = useState<string | null>(null);

  // Hidden until we know the session supports model selection.
  if (!sessionId || isPending || !data || !data.supported) return null;

  const { currentModelId, availableModels } = data;
  if (availableModels.length === 0) return null;

  const current = availableModels.find((m) => m.id === currentModelId);
  // Trigger shows the versioned name (e.g. "Opus 4.8") even for Default; the
  // dropdown rows keep the friendlier `name`.
  const label = current ? modelDisplayLabel(current) : currentModelId;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Model: ${label}`}
        className="cursor-pointer flex h-8 items-center gap-1 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors outline-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring/50"
      >
        <span className="max-w-[10rem] truncate">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 flex-shrink-0" strokeWidth={2.2} />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={6}
        className="max-h-80 w-72 overflow-y-auto"
      >
        <div className="px-2 pt-1 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Model
        </div>
        {availableModels.map((model) => {
          const isCurrent = model.id === currentModelId;
          return (
            <DropdownMenuItem
              key={model.id}
              disabled={setModel.isPending}
              onClick={() => {
                if (setModel.isPending || isCurrent) return;
                setModel.mutate(
                  { modelId: model.id },
                  {
                    onError: (err) =>
                      setError(err instanceof Error ? err.message : "Failed to set model"),
                    onSuccess: () => setError(null),
                  },
                );
              }}
              className="flex items-start gap-2 cursor-pointer py-2"
            >
              <Check
                className={`mt-0.5 h-4 w-4 flex-shrink-0 ${isCurrent ? "opacity-100" : "opacity-0"}`}
                strokeWidth={2.2}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{model.name}</span>
                {model.description && (
                  <span className="text-xs leading-snug text-muted-foreground whitespace-normal">
                    {model.description}
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
