import { isDeepStrictEqual } from "node:util";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { ALWAYS_LOAD_META_KEY, ALWAYS_LOAD_TOOLS } from "@/lib/mcp/agent-surface";
import { LEGACY_INPUT_FIELDS } from "@/mcp/tools/legacy-inputs";
import { isMergedToolName } from "@/lib/agents/merged-tools";

/**
 * One post-process for every `tools/list` libi serves.
 *
 * The SDK's `McpServer` adds two things to every tool that no client needs:
 *  - `"$schema": "http://json-schema.org/draft-07/schema#"` on each input (and
 *    output) schema — 51 bytes x 211 tools, and the dialect is the default
 *    anyway;
 *  - `execution: { taskSupport: "forbidden" }`, which the MCP spec defines as
 *    what an ABSENT `execution` means ("If not present, defaults to
 *    forbidden", types.js `ToolExecutionSchema`), and the SDK client reads it
 *    the same way (`tool.execution?.taskSupport`).
 * Together they were ~19 KB of every list. Because the dialect marker is gone,
 * a client is free to read the schemas as JSON Schema 2020-12 (Claude Code
 * 2.1.282 does), where draft-07's tuple form `items: [a, b]` is INVALID and the
 * client drops the whole tool ("items must be object,boolean"). So tuples are
 * rewritten into a form valid in both drafts (`rewriteTuples`). This also pins the tools named in
 * `ALWAYS_LOAD_TOOLS` with `_meta["anthropic/alwaysLoad"]`, and drops the
 * input fields in `LEGACY_INPUT_FIELDS` (still accepted at call time, no longer
 * advertised). A merged tool's flat schema is `.passthrough()` (so the SDK strips
 * nothing before the per-action parse, mcp/tools/action-tool.ts), which zod
 * emits as `additionalProperties: true`; it is advertised as `false`, like the
 * per-verb tools it replaced, because the union lists every key any action takes.
 *
 * It lives here, applied inside `createLibiMcpServer` (and the standalone
 * tracking server), rather than in the HTTP aggregator, so the stdio entry and
 * the in-memory hop the aggregator itself uses see the same list.
 */

const DEFAULT_EXECUTION_TASK_SUPPORT = "forbidden";

function stripSchemaKey<T>(schema: T): T {
  if (schema && typeof schema === "object" && "$schema" in (schema as object)) {
    const { $schema: _dropped, ...rest } = schema as Record<string, unknown>;
    void _dropped;
    return rest as T;
  }
  return schema;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Keywords whose value is ONE subschema. */
const SCHEMA_KEYS = [
  "items",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;
/** Keywords whose value is an array of subschemas. */
const SCHEMA_LIST_KEYS = ["anyOf", "oneOf", "allOf", "prefixItems"] as const;
/** Keywords whose value is a map of name -> subschema. */
const SCHEMA_MAP_KEYS = [
  "properties",
  "patternProperties",
  "definitions",
  "$defs",
  "dependentSchemas",
] as const;

function uniqueSchemas(members: unknown[]): unknown[] {
  const out: unknown[] = [];
  for (const m of members) if (!out.some((o) => isDeepStrictEqual(o, m))) out.push(m);
  return out;
}

/**
 * Rewrite draft-07 tuple `items: [a, b]` into `{ items: <a | anyOf[a, b]>,
 * minItems: n, maxItems: n }`, which is valid in draft-07 AND 2020-12 (where
 * `items` must be a schema and the tuple keyword is `prefixItems`). The exact
 * per-position check is lost to the CLIENT only; the server's zod schema still
 * enforces it on every call. `additionalItems` (renamed in 2020-12) is dropped:
 * a schema-valued one joins the item schema and lifts the `maxItems` cap, `false`
 * (or absent with an existing `maxItems`) keeps the cap. Walks every
 * subschema-bearing keyword; pure, returns new objects only where it changed
 * something.
 */
export function rewriteTuples<T>(schema: T): T {
  return walk(schema) as T;
}

function walk(node: unknown): unknown {
  if (!isObj(node)) return node;
  let out: Record<string, unknown> = node;
  const set = (k: string, v: unknown) => {
    if (out === node) out = { ...node };
    out[k] = v;
  };

  for (const k of SCHEMA_KEYS) {
    if (k === "items" && Array.isArray(node.items)) continue; // handled below
    if (k in node && isObj(node[k])) {
      const w = walk(node[k]);
      if (w !== node[k]) set(k, w);
    }
  }
  for (const k of SCHEMA_LIST_KEYS) {
    const list = node[k];
    if (Array.isArray(list)) {
      const mapped = list.map(walk);
      if (mapped.some((m, i) => m !== list[i])) set(k, mapped);
    }
  }
  for (const k of SCHEMA_MAP_KEYS) {
    const map = node[k];
    if (isObj(map)) {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(map)) {
        const w = isObj(sub) ? walk(sub) : sub; // dependencies may hold string[]
        if (w !== sub) changed = true;
        next[name] = w;
      }
      if (changed) set(k, next);
    }
  }
  // draft-07 `dependencies` mixes subschemas and string arrays
  if (isObj(node.dependencies)) {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [name, sub] of Object.entries(node.dependencies)) {
      const w = isObj(sub) ? walk(sub) : sub;
      if (w !== sub) changed = true;
      next[name] = w;
    }
    if (changed) set("dependencies", next);
  }

  if (Array.isArray(node.items)) {
    const members = node.items.map(walk);
    const rest = node.additionalItems;
    const hasRest = isObj(rest);
    const all = uniqueSchemas(hasRest ? [...members, walk(rest)] : members);
    const n = members.length;
    const { items: _i, additionalItems: _a, ...others } = out;
    void _i;
    void _a;
    const next: Record<string, unknown> = { ...others };
    if (all.length === 1) next.items = all[0];
    else if (all.length > 1) next.items = { anyOf: all };
    if (typeof next.minItems !== "number") next.minItems = n;
    // no schema-valued rest -> the tuple is exact (zod's always is)
    if (typeof next.maxItems !== "number" && !hasRest) next.maxItems = n;
    if (!("type" in next)) next.type = "array";
    return next;
  }
  // `additionalItems` without tuple items is meaningless (and gone in 2020-12)
  if ("additionalItems" in out) {
    const { additionalItems: _a, ...others } = out;
    void _a;
    return others;
  }
  return out;
}

/**
 * Drop schema noise every client reads past: `additionalProperties: false` on a NESTED object (the top-level
 * one stays — merged tools advertise it on purpose) and `minLength: 1`. Both are ~6 KB across the list; the
 * server's zod schema still enforces them on every call, and a refusal names the field.
 */
export function compactSchema<T>(schema: T): T {
  const go = (node: unknown, root: boolean): unknown => {
    if (Array.isArray(node)) return node.map((n) => go(n, false));
    if (!isObj(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "additionalProperties" && v === false && !root) continue;
      if (k === "minLength" && v === 1) continue;
      if (k === "properties" && isObj(v)) {
        out[k] = Object.fromEntries(Object.entries(v).map(([name, sub]) => [name, go(sub, false)]));
      } else {
        out[k] = go(v, false);
      }
    }
    return out;
  };
  return go(schema, true) as T;
}

/** Remove `fields` from an input schema's `properties` and `required`. */
function dropProperties(schema: Tool["inputSchema"], fields: readonly string[]): Tool["inputSchema"] {
  const props = schema.properties as Record<string, object> | undefined;
  if (!props || !fields.some((f) => f in props)) return schema;
  const properties = Object.fromEntries(Object.entries(props).filter(([k]) => !fields.includes(k)));
  const out: Tool["inputSchema"] = { ...schema, properties };
  if (Array.isArray(schema.required)) {
    const required = schema.required.filter((k) => !fields.includes(k));
    if (required.length > 0) out.required = required;
    else delete out.required;
  }
  return out;
}

function isDefaultExecution(execution: Tool["execution"]): boolean {
  if (!execution) return false;
  const keys = Object.keys(execution);
  return (
    keys.length === 0 ||
    (keys.length === 1 && execution.taskSupport === DEFAULT_EXECUTION_TASK_SUPPORT)
  );
}

/** Shape one tool entry. Pure; never mutates its input. */
export function shapeTool(tool: Tool, alwaysLoad: readonly string[] = ALWAYS_LOAD_TOOLS): Tool {
  const { execution, inputSchema, outputSchema, _meta, ...rest } = tool;
  const legacy = LEGACY_INPUT_FIELDS[tool.name];
  const cleaned = compactSchema(rewriteTuples(stripSchemaKey(inputSchema)));
  const dropped = legacy ? dropProperties(cleaned, legacy) : cleaned;
  const shaped: Tool = {
    ...rest,
    inputSchema: isMergedToolName(tool.name) ? { ...dropped, additionalProperties: false } : dropped,
  };
  if (outputSchema !== undefined) shaped.outputSchema = rewriteTuples(stripSchemaKey(outputSchema));
  if (execution !== undefined && !isDefaultExecution(execution)) shaped.execution = execution;
  const meta = alwaysLoad.includes(tool.name)
    ? { ...(_meta ?? {}), [ALWAYS_LOAD_META_KEY]: true }
    : _meta;
  if (meta !== undefined) shaped._meta = meta;
  return shaped;
}

export function shapeToolsList(
  tools: readonly Tool[],
  alwaysLoad: readonly string[] = ALWAYS_LOAD_TOOLS,
): Tool[] {
  return tools.map((t) => shapeTool(t, alwaysLoad));
}

type RawHandler = (request: unknown, extra: unknown) => Promise<{ tools: Tool[] } & Record<string, unknown>>;

/**
 * Wrap the SDK's own `tools/list` handler so its answer goes through
 * `shapeToolsList`. Call it AFTER the last `registerTool` — the SDK installs
 * that handler lazily on the first registration. With none registered it does
 * nothing.
 *
 * Reaches into the SDK's handler table because `McpServer` has no hook between
 * building the list and sending it; `__tests__/unit/mcp/tools-list-shape.test.ts`
 * fails loudly if an SDK upgrade moves it.
 */
export function installToolsListShaping(server: McpServer): void {
  const handlers = (server.server as unknown as { _requestHandlers?: Map<string, RawHandler> })
    ._requestHandlers;
  const inner = handlers?.get("tools/list");
  // No handler = nothing was registered (a test that stubs `registerTool`).
  // The real-server test below proves the handler exists and is wrapped.
  if (!handlers || !inner) return;
  handlers.set("tools/list", async (request, extra) => {
    const result = await inner(request, extra);
    return { ...result, tools: shapeToolsList(result.tools) };
  });
}
