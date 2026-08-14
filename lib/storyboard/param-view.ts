import type { GenFieldDef, GenFieldType, ModelSchema, GenParamValue } from "./gen-schema";
import type { GenSpec } from "./types";
import { catalogEntry, type ParamGroup } from "./param-catalog";

export type ParamView = {
  key: string;
  label: string;
  type: GenFieldType;
  value: GenParamValue;
  options?: (string | number)[];
  multiple?: boolean;
  min?: number; max?: number; step?: number;
  group: ParamGroup | "Additional";
  known: boolean;
};

export type CardParamView = { params: ParamView[] };

/** Pure: turn a spec's chosen values + the cached schema into renderable params.
 *  Only params present in `spec.params` are emitted; their type/options come from
 *  the schema field def (falling back to "text" when the schema lacks the field).
 *  `known` + `group` come from the catalog; unknown keys land in "Additional". */
export function buildParamView(spec: GenSpec | undefined, schema: ModelSchema | undefined): CardParamView {
  if (!spec) return { params: [] };
  const byKey = new Map((schema?.fields ?? []).map((f) => [f.key, f]));
  const params: ParamView[] = [];
  for (const [key, value] of Object.entries(spec.params)) {
    const def: GenFieldDef | undefined = byKey.get(key);
    const cat = catalogEntry(key);
    // Schema options win; otherwise fall back to the catalog's closed list for
    // well-known constrained params (aspect ratio, duration). Always include the
    // current value so the <select> shows the actual setting even if it's outside
    // the fallback set.
    let options = def?.options;
    if ((!options || options.length === 0) && cat?.fallbackOptions) {
      options = cat.fallbackOptions.includes(value as string | number)
        ? cat.fallbackOptions
        : [...cat.fallbackOptions, value as string | number];
    }
    params.push({
      key,
      label: cat?.label ?? key,
      type: def?.type ?? "text",
      value,
      options,
      multiple: def?.multiple,
      min: def?.min, max: def?.max, step: def?.step,
      group: cat?.group ?? "Additional",
      known: !!cat,
    });
  }
  return { params };
}
