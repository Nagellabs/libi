/**
 * Tolerant argument coercion for MCP tool inputs.
 *
 * Some MCP clients — notably the Claude Code ACP adapter (`claude-agent-acp`) —
 * intermittently send typed tool arguments (objects, arrays, numbers, booleans)
 * as *stringified JSON*: `"720"` instead of `720`, or `"[{...}]"` instead of an
 * array. libi's strict Zod input schemas then reject them with
 * "Expected object/array/number, received string", forcing the agent to retry
 * (and, in one observed case, silently dropping an `aiGeneration` object).
 *
 * This module wraps a tool's input schema so that, *before* validation, any
 * field whose declared base type is NOT string-like gets a `JSON.parse` pass
 * when the incoming value is a JSON-looking string. String / enum / literal
 * fields are left untouched, so a legitimate string value is never corrupted.
 *
 * Applied once at the MCP registration boundary (see `installArgCoercion`), it
 * fixes every libi tool at a single point without editing individual schemas.
 *
 * IMPORTANT: the result preserves the original schema *form* — a ZodRawShape
 * stays a raw shape, a ZodObject stays a ZodObject (with strict/passthrough/
 * catchall re-applied). It never returns a top-level `ZodEffects`, because the
 * MCP SDK's `normalizeObjectSchema` only recognises raw shapes and ZodObjects;
 * handing it a ZodEffects would blank the tool's emitted JSON schema.
 */
import { z } from "zod/v3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

type RawShape = Record<string, z.ZodTypeAny>;

// Base Zod types that are definitely NOT strings, so a JSON-looking string
// value was certainly meant to be the parsed value.
const COERCIBLE_BASE = new Set([
  "ZodObject",
  "ZodArray",
  "ZodRecord",
  "ZodTuple",
  "ZodNumber",
  "ZodBoolean",
]);

/** Unwrap Optional / Nullable / Default / Effects to the underlying base typeName. */
function baseTypeName(schema: z.ZodTypeAny): string {
  let s: unknown = schema;
  for (let i = 0; i < 12; i++) {
    const def = (
      s as { _def?: { typeName?: string; innerType?: unknown; schema?: unknown } }
    )?._def;
    if (!def) return "";
    const tn = def.typeName ?? "";
    if (tn === "ZodOptional" || tn === "ZodNullable" || tn === "ZodDefault") {
      s = def.innerType;
    } else if (tn === "ZodEffects") {
      s = def.schema;
    } else {
      return tn;
    }
  }
  return "";
}

/** Whether a string should even be considered for JSON parsing. */
function looksLikeJson(v: string): boolean {
  const t = v.trim();
  if (t === "") return false;
  const c = t[0];
  return (
    c === "{" ||
    c === "[" ||
    c === "-" ||
    (c >= "0" && c <= "9") ||
    t === "true" ||
    t === "false" ||
    t === "null"
  );
}

function parseIfJsonString(v: unknown): unknown {
  if (typeof v !== "string" || !looksLikeJson(v)) return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function coerceField(schema: z.ZodTypeAny): z.ZodTypeAny {
  if (!COERCIBLE_BASE.has(baseTypeName(schema))) return schema;
  return z.preprocess(parseIfJsonString, schema);
}

function mapShape(shape: RawShape): RawShape {
  const out: RawShape = {};
  for (const key of Object.keys(shape)) out[key] = coerceField(shape[key]);
  return out;
}

function isZodObject(v: unknown): v is z.AnyZodObject {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as { _def?: { typeName?: string } })._def?.typeName === "ZodObject"
  );
}

/**
 * Return a coercing variant of `inputSchema`, preserving its original form.
 */
export function coerceInputSchema(inputSchema: unknown): unknown {
  if (inputSchema == null) return inputSchema;

  if (isZodObject(inputSchema)) {
    const def = inputSchema._def as {
      unknownKeys?: "strip" | "strict" | "passthrough";
      catchall?: z.ZodTypeAny;
    };
    let rebuilt: z.AnyZodObject = z.object(mapShape(inputSchema.shape as RawShape));
    if (def.unknownKeys === "strict") rebuilt = rebuilt.strict();
    else if (def.unknownKeys === "passthrough") rebuilt = rebuilt.passthrough();
    if (def.catchall && baseTypeName(def.catchall) !== "ZodNever") {
      rebuilt = rebuilt.catchall(def.catchall);
    }
    return rebuilt;
  }

  // A plain object with no `_def` is a ZodRawShape (`{ name: z.string() }`).
  if (typeof inputSchema === "object" && !("_def" in (inputSchema as object))) {
    return mapShape(inputSchema as RawShape);
  }

  // Anything else (a non-object Zod schema we don't special-case) is returned
  // unchanged so registration never breaks over an unexpected shape.
  return inputSchema;
}

type RegisterToolFn = (
  name: string,
  config: { inputSchema?: unknown } & Record<string, unknown>,
  cb: unknown,
) => unknown;

/**
 * Monkey-patch `server.registerTool` so every tool registered afterwards gets
 * tolerant arg coercion applied to its `inputSchema`. Call once, immediately
 * after constructing the McpServer and before registering any tools.
 */
export function installArgCoercion(server: McpServer): void {
  // The SDK's `registerTool` is heavily overloaded; treat it structurally for
  // the monkey-patch and let the SDK keep validating call sites elsewhere.
  const srv = server as unknown as { registerTool: RegisterToolFn };
  const original = srv.registerTool.bind(srv) as RegisterToolFn;
  srv.registerTool = ((name, config, cb) => {
    if (config && "inputSchema" in config && config.inputSchema != null) {
      try {
        config = { ...config, inputSchema: coerceInputSchema(config.inputSchema) };
      } catch {
        // On any unexpected schema shape, fall back to the original schema —
        // never block tool registration over coercion.
      }
    }
    return original(name, config, cb);
  }) as RegisterToolFn;
}
