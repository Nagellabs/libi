export type GenFieldType =
  | "text" | "number" | "boolean" | "url" | "enum"
  | "image" | "video" | "audio" | "svg" | "pdf";

export type GenFieldDef = {
  key: string;
  type: GenFieldType;
  required?: boolean;
  options?: (string | number)[];
  min?: number;
  max?: number;
  step?: number;
  multiple?: boolean;
  label?: string;
  description?: string;
  default?: string | number | boolean;
};

export type ModelSchema = { apiUrl: string; model: string; fields: GenFieldDef[] };

export type GenParamValue = string | number | boolean | string[];

export type ValidationIssue = {
  key: string;
  problem: "unknown_key" | "wrong_type" | "not_in_options" | "out_of_range" | "missing_required";
  message: string;
};

const MEDIA_TYPES: GenFieldType[] = ["image", "video", "audio", "svg", "pdf", "url"];

function typeMatches(def: GenFieldDef, value: GenParamValue): boolean {
  if (def.multiple) {
    return Array.isArray(value) && value.every((v) => typeof v === "string");
  }
  if (MEDIA_TYPES.includes(def.type)) return typeof value === "string";
  if (def.type === "text") return typeof value === "string";
  if (def.type === "number") return typeof value === "number";
  if (def.type === "boolean") return typeof value === "boolean";
  if (def.type === "enum") return typeof value === "string" || typeof value === "number";
  return false;
}

/** Pure: check chosen param values against the cached field defs. Returns one
 *  issue per violation (empty array = valid). This is the validation gate the
 *  set_storyboard_generation tool runs before persisting a spec. */
export function validateParams(
  params: Record<string, GenParamValue>,
  fields: GenFieldDef[],
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const byKey = new Map(fields.map((f) => [f.key, f]));

  for (const [key, value] of Object.entries(params)) {
    const def = byKey.get(key);
    if (!def) {
      issues.push({ key, problem: "unknown_key", message: `'${key}' is not a parameter of this endpoint` });
      continue;
    }
    if (!typeMatches(def, value)) {
      issues.push({ key, problem: "wrong_type", message: `'${key}' must be ${def.multiple ? def.type + "[]" : def.type}` });
      continue;
    }
    if (def.options && !def.options.includes(value as string | number)) {
      issues.push({ key, problem: "not_in_options", message: `'${key}' must be one of ${def.options.join(", ")}` });
      continue;
    }
    if (def.type === "number" && typeof value === "number") {
      if ((def.min !== undefined && value < def.min) || (def.max !== undefined && value > def.max)) {
        issues.push({ key, problem: "out_of_range", message: `'${key}' must be within [${def.min ?? "-∞"}, ${def.max ?? "∞"}]` });
      }
    }
  }

  for (const f of fields) {
    if (f.required && params[f.key] === undefined) {
      issues.push({ key: f.key, problem: "missing_required", message: `'${f.key}' is required` });
    }
  }
  return issues;
}

const FIELD_TYPES: GenFieldType[] = ["text", "number", "boolean", "url", "enum", "image", "video", "audio", "svg", "pdf"];

/** Pure: validate that an agent-supplied schema is a well-formed GenFieldDef[].
 *  Used by save_model_schema_cache so a malformed cache can never be stored. */
export function validateFieldDefs(fields: unknown): { ok: boolean; error?: string } {
  if (!Array.isArray(fields)) return { ok: false, error: "fields must be an array" };
  for (const f of fields) {
    if (!f || typeof f !== "object") return { ok: false, error: "each field must be an object" };
    const def = f as Record<string, unknown>;
    if (typeof def.key !== "string" || !def.key) return { ok: false, error: "each field needs a non-empty 'key'" };
    if (!FIELD_TYPES.includes(def.type as GenFieldType)) {
      return { ok: false, error: `field '${String(def.key)}' has invalid type '${String(def.type)}'` };
    }
  }
  return { ok: true };
}
