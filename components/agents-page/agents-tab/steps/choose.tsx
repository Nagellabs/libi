"use client";

import { getAgentSetup } from "@/lib/agents/setup/registry";
import type { SetupAgentId } from "@/lib/agents/setup/commands";
import { cn } from "@/lib/utils";
import { WIZARD_AGENTS } from "../wizard-state";
import { reportStepCompleted } from "./shared";

export function ChooseStep({ selected, onAgent }: { selected: SetupAgentId | null; onAgent: (agent: SetupAgentId) => void }) {
  return (
    <div data-testid="wizard-step-choose" className="grid gap-3 sm:grid-cols-2">
      {WIZARD_AGENTS.map(({ id, name }) => (
        <button
          key={id}
          type="button"
          className={cn(
            "cursor-pointer rounded-lg border p-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50",
            selected === id ? "border-foreground/40" : "border-border",
          )}
          onClick={() => {
            reportStepCompleted(id, "choose");
            onAgent(id);
          }}
        >
          <span className="block text-sm font-medium text-foreground">{name}</span>
          <span className="mt-0.5 block text-xs text-muted-foreground">{getAgentSetup(id)?.blurb}</span>
        </button>
      ))}
    </div>
  );
}
