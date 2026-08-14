"use client";

import type { CardParamView, ParamView } from "@/lib/storyboard/param-view";
import { GROUP_ORDER, type ParamGroup } from "@/lib/storyboard/param-catalog";
import type { GenFieldType } from "@/lib/storyboard/gen-schema";
import type { GenParamValue } from "@/lib/storyboard/types";
import { ParamEditor } from "./param-editor";

/** Media types whose values are fileIds — rendered by the dedicated media rows,
 *  not here. */
const MEDIA_TYPES: GenFieldType[] = ["image", "video", "audio", "svg", "pdf"];

function isMediaType(type: GenFieldType): boolean {
  return MEDIA_TYPES.includes(type);
}

/** Render a single param value as a readable string. */
function formatValue(p: ParamView): string {
  const v = p.value;
  if (typeof v === "boolean") return v ? "on" : "off";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}

type EditProps = {
  onEditParam?: (key: string, value: GenParamValue) => void;
  errors?: Record<string, string>;
};

/** A single param row: label + (editable | read-only) value. */
function ParamRow({ param, onEditParam, errors }: { param: ParamView } & EditProps) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="text-[11px] text-muted-foreground shrink-0">{param.label}</span>
      {onEditParam ? (
        <ParamEditor
          param={param}
          error={errors?.[param.key]}
          onCommit={(v) => onEditParam(param.key, v)}
        />
      ) : (
        <span className="text-[11px] text-foreground/90 text-right truncate max-w-[60%]">
          {formatValue(param)}
        </span>
      )}
    </div>
  );
}

/** Known non-media params grouped by GROUP_ORDER.  */
function KnownParamsSection({ params, onEditParam, errors }: { params: ParamView[] } & EditProps) {
  // Build a map from group → params, preserving GROUP_ORDER
  const byGroup = new Map<ParamGroup, ParamView[]>();
  for (const g of GROUP_ORDER) byGroup.set(g, []);
  for (const p of params) {
    if (p.group !== "Additional") {
      byGroup.get(p.group as ParamGroup)?.push(p);
    }
  }

  const sections: { group: ParamGroup; items: ParamView[] }[] = [];
  for (const g of GROUP_ORDER) {
    const items = byGroup.get(g) ?? [];
    if (items.length > 0) sections.push({ group: g, items });
  }

  if (sections.length === 0) return null;

  return (
    <>
      {sections.map(({ group, items }) => (
        <div key={group}>
          <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60 mt-2 mb-0.5">
            {group}
          </div>
          {items.map((p) => (
            <ParamRow key={p.key} param={p} onEditParam={onEditParam} errors={errors} />
          ))}
        </div>
      ))}
    </>
  );
}

interface ParamListProps extends EditProps {
  view: CardParamView;
}

/** List of non-media, non-prompt params from a CardParamView. Read-only unless
 *  an `onEditParam` callback is provided, in which case each value becomes a
 *  typed editor. Media params (image/video/audio/svg/pdf) are handled by the
 *  dedicated row components; the `prompt` key renders separately. Known params
 *  are grouped; any unknown params render as plain rows in the same list (no
 *  separate "Additional parameters" section). */
export function ParamList({ view, onEditParam, errors }: ParamListProps) {
  // Filter: exclude media types and the prompt key
  const filtered = view.params.filter(
    (p) => !isMediaType(p.type) && p.key !== "prompt",
  );

  const known = filtered.filter((p) => p.group !== "Additional" && p.known);
  const unknown = filtered.filter((p) => p.group === "Additional" || !p.known);

  if (filtered.length === 0) return null;

  return (
    <div>
      <KnownParamsSection params={known} onEditParam={onEditParam} errors={errors} />
      {unknown.map((p) => (
        <ParamRow key={p.key} param={p} onEditParam={onEditParam} errors={errors} />
      ))}
    </div>
  );
}
