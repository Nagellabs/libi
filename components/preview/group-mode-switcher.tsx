"use client";

import {
  groupsForKind,
  hasGroupsForKind,
  type InspectorGroup,
  type InspectorOverlayKind,
} from "@/lib/overlays/inspector-fields";

const LABELS: Record<InspectorGroup, string> = {
  transform: "Transform",
  style: "Style",
  text: "Text",
  "3d": "3D",
  anchors: "Anchors",
};

/**
 * A per-kind full-width segmented tab bar (intent-group tabs). Renders one tab
 * per `groupsForKind(kind)`, styled to mirror the preview panel's tab
 * controller — the active tab gets an emphasized label + an accent bottom
 * border. A kind with a single group (every non-text kind) renders NOTHING —
 * there is no tab to choose. The caller owns `mode`/`onChange` (per-overlay
 * state lives in editor-state).
 *
 * Export name kept as `GroupModeSwitcher` to minimize churn at call sites.
 */
export function GroupModeSwitcher({
  kind,
  mode,
  onChange,
  className,
}: {
  kind: InspectorOverlayKind;
  mode: InspectorGroup;
  onChange: (mode: InspectorGroup) => void;
  className?: string;
}) {
  if (!hasGroupsForKind(kind)) return null;
  const groups = groupsForKind(kind);

  return (
    <div
      className={`flex w-full items-stretch ${className ?? ""}`}
      role="tablist"
      aria-label="Inspector group"
    >
      {groups.map((group) => {
        const active = mode === group;
        return (
          <button
            key={group}
            type="button"
            role="tab"
            data-active={active}
            aria-selected={active}
            onClick={() => onChange(group)}
            className={`relative flex-1 cursor-pointer border-b-2 px-2 py-1.5 text-center text-[11px] font-medium transition-colors ${
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {LABELS[group]}
          </button>
        );
      })}
    </div>
  );
}
