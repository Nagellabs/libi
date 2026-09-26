"use client";

import { LayoutGrid, List } from "lucide-react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { TemplatesView } from "@/components/templates/templates-page/use-templates-page-params";

const ITEMS: ReadonlyArray<{ value: TemplatesView; label: string; Icon: typeof List }> = [
  { value: "cards", label: "Cards", Icon: LayoutGrid },
  { value: "list", label: "List", Icon: List },
];

/**
 * Cards | List, in the Templates toolbar. Exactly one is always pressed:
 * pressing the active item again would clear a toggle group, so that change
 * is ignored rather than reported.
 */
export function ViewSwitch({ value, onChange }: { value: TemplatesView; onChange: (v: TemplatesView) => void }) {
  return (
    <ToggleGroup
      aria-label="View"
      variant="outline"
      size="sm"
      data-testid="templates-view-switch"
      value={[value]}
      onValueChange={(next) => {
        const v = next[0] as TemplatesView | undefined;
        if (v && v !== value) onChange(v);
      }}
    >
      {ITEMS.map(({ value: v, label, Icon }) => (
        <ToggleGroupItem key={v} value={v} className="cursor-pointer gap-1 text-xs" data-testid={`templates-view-${v}`}>
          <Icon data-icon="inline-start" className="size-3.5" />
          {label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
