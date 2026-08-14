"use client";

import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/**
 * In-group progressive disclosure. Renders the `common` controls always, then
 * an "Advanced ▾" toggle that reveals the `advanced` controls. The advanced
 * children are ALWAYS MOUNTED (only visually collapsed via CSS) so their
 * `data-field` markers stay present for the registry↔render coverage test and
 * so a highlight can flash a field inside a collapsed group.
 *
 * When `hasAdvanced` is false the advanced disclosure (header + toggle + body)
 * is omitted entirely — only `common` renders. Call sites pass `false` when the
 * active (kind, group) tab has ZERO advanced fields, so the user never sees an
 * "ADVANCED" toggle that opens to nothing. Suppressing the section removes no
 * `data-field` markers: an empty advanced slot has none to begin with (its
 * `GroupField` children gate themselves out for the active group).
 */
export function InGroupAdvanced({
  common,
  advanced,
  hasAdvanced = true,
  className,
}: {
  common: ReactNode;
  advanced: ReactNode;
  /** Whether the active tab has any advanced fields. Defaults to true. */
  hasAdvanced?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  // Narrow panels get a roomier vertical gap (rows wrap under their labels and
  // would otherwise crowd); collapses back to gap-1.5 once the panel is wide.
  const colGap = "gap-2.5 @[300px]:gap-1.5";

  if (!hasAdvanced) {
    return <div className={`flex flex-col ${colGap} ${className ?? ""}`}>{common}</div>;
  }

  return (
    <div className={`flex flex-col ${colGap} ${className ?? ""}`}>
      {common}
      <button
        type="button"
        data-testid="in-group-advanced-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex cursor-pointer items-center gap-1 self-start rounded px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:text-foreground"
      >
        <ChevronDown
          className={`size-3 transition-transform ${open ? "rotate-180" : ""}`}
        />
        Advanced
      </button>
      {/* Always mounted; collapsed via CSS so data-field markers persist. */}
      <div className={open ? `flex flex-col ${colGap}` : "hidden"}>{advanced}</div>
    </div>
  );
}
