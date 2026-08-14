"use client";

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";

import {
  fieldKeysForKindGroup,
  isKnownFieldKey,
  groupForField,
  type InspectorGroup,
  type InspectorOverlayKind,
} from "@/lib/overlays/inspector-fields";

/** The active highlight request (from the agent's `highlight_property` tool). */
export interface FieldHighlight {
  /** The field key to flash — matched against each GroupField's `fieldKey`. */
  property: string;
  /** Optional explanatory note rendered in a callout bubble. */
  note?: string;
}

/**
 * Highlight context so every `<GroupField>` can flash without threading a
 * `highlight` prop through every inspector body + sub-inspector. The preview
 * surface wraps the inspector in `<HighlightProvider value={...}>` from the
 * highlight store; an explicit `highlight` prop on a GroupField still wins.
 */
const HighlightContext = createContext<FieldHighlight | null>(null);

export function HighlightProvider({
  value,
  children,
}: {
  value: FieldHighlight | null;
  children: ReactNode;
}) {
  return <HighlightContext.Provider value={value}>{children}</HighlightContext.Provider>;
}

/**
 * Gates a single inspector field by the EXACT active tab (intent-group model)
 * for a given overlay `kind`, tags it with a `data-field` attribute (the
 * highlight target + coverage marker), and flashes it when the active highlight
 * matches.
 *
 * Two distinct null cases:
 *  - DRIFT: an unknown `fieldKey` (in no kind) THROWS in dev/test — a field
 *    rendered in the inspector must exist in `INSPECTOR_FIELDS`.
 *  - NOT-APPLICABLE / WRONG-TAB: a known key whose group for this kind is not the
 *    active `group` (or the key doesn't apply to the kind at all) silently
 *    `return null` — no throw.
 */
export function GroupField({
  fieldKey,
  kind,
  group,
  highlight,
  children,
}: {
  fieldKey: string;
  kind: InspectorOverlayKind;
  group: InspectorGroup;
  highlight?: FieldHighlight | null;
  children: ReactNode;
}) {
  // Hooks run unconditionally (before any early return) so hook order is stable
  // regardless of gating outcome.
  const ctxHighlight = useContext(HighlightContext);
  const active = highlight ?? ctxHighlight;
  const ref = useRef<HTMLDivElement | null>(null);
  const isHighlighted = active?.property === fieldKey;

  useEffect(() => {
    if (!isHighlighted) return;
    // jsdom has no layout — guard scrollIntoView.
    ref.current?.scrollIntoView?.({ behavior: "smooth", block: "center" });
  }, [isHighlighted]);

  if (!isKnownFieldKey(fieldKey)) {
    if (process.env.NODE_ENV !== "production") {
      throw new Error(
        `GroupField: unknown fieldKey "${fieldKey}" — add it to lib/overlays/inspector-fields.ts`,
      );
    }
    return null;
  }

  // Exact-group gate: render only when this field's group FOR THIS KIND equals
  // the active tab. Wrong tab OR not-applicable-to-kind ⇒ silent null.
  if (groupForField(fieldKey, kind) !== group) return null;

  return (
    <div
      ref={ref}
      data-field={fieldKey}
      data-highlight={isHighlighted ? "true" : undefined}
      className={
        isHighlighted
          ? "relative rounded ring-2 ring-primary ring-offset-1 ring-offset-background transition-shadow"
          : undefined
      }
    >
      {children}
      {isHighlighted && active?.note ? (
        <div className="mt-1 rounded bg-primary/15 px-2 py-1 text-[11px] text-foreground">
          {active.note}
        </div>
      ) : null}
    </div>
  );
}

/**
 * A section wrapper that renders its heading + children only when at least one
 * of its field keys is at the active (kind, group) tab — so an all-gated
 * section disappears entirely.
 */
export function GroupSection({
  title,
  fieldKeys,
  kind,
  group,
  children,
}: {
  title: string;
  fieldKeys: string[];
  kind: InspectorOverlayKind;
  group: InspectorGroup;
  children: ReactNode;
}) {
  const atTab = new Set(fieldKeysForKindGroup(kind, group));
  const anyVisible = fieldKeys.some((key) => atTab.has(key));
  if (!anyVisible) return null;

  return (
    <section>
      {title ? (
        <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h4>
      ) : null}
      {children}
    </section>
  );
}
