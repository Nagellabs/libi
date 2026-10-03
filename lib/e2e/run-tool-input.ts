/**
 * Argument validation for the test-only `/api/e2e/run-tool` route, done the way
 * libi's MCP endpoint does it for an agent's call.
 *
 * The route calls a tool FUNCTION directly, which skips the MCP layer, and with
 * it every check an agent's arguments go through. Seeds written against it
 * rotted without a sound: a missing required field was persisted as
 * `undefined`, a misnamed one dropped (docs-local/qa/2026-09-26-e2e-fixes-report.md).
 * So the route validates first, through the same three steps as
 * `createLibiMcpServer()`:
 *
 *   1. the tool's input schema from `mcp/tools/schemas.ts`, in the form
 *      `mcp/server.ts` registers it (a ZodObject or its raw `.shape`);
 *   2. wrapped by `coerceInputSchema` (`installArgCoercion` does that to every
 *      tool registered on the server);
 *   3. normalised to an object schema, parsed and — on failure — worded the
 *      way the MCP SDK's `McpServer.validateToolInput` does, and returned as the
 *      `CallToolResult` its `createToolError` builds.
 *
 * Step 3 is a few lines VENDORED from the SDK's `server/zod-compat.js`
 * (`normalizeObjectSchema`, `safeParseAsync`, `getParseErrorMessage`), which is
 * not a documented entry point — reachable only through the package's `./*`
 * wildcard export, so a minor SDK bump may move it. Only the zod v3 branch is
 * kept: every libi tool schema is zod v3 (AGENTS.md → MCP). The unit test holds
 * the copy to the SDK's own helpers and to a real server's refusal text.
 *
 * The handler then receives the PARSED arguments (defaults applied, JSON-string
 * numbers coerced), as it does behind the MCP endpoint.
 *
 * `__tests__/unit/api/e2e-run-tool-route.test.ts` holds the table to the
 * server: every tool here must advertise the same input schema on
 * `createLibiMcpServer()`, and a refusal must match an agent's word for word.
 */
import { z } from "zod/v3";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { coerceInputSchema } from "@/mcp/tools/coerce-args";
import { actionRunnerFor, type ActionToolDef } from "@/mcp/tools/action-tool";
import { templateTool } from "@/mcp/tools/families/template";
import { layerEffectTool } from "@/mcp/tools/families/layer-effect";
import { effectTool } from "@/mcp/tools/families/effect";
import {
  TrimVideoSchema,
  UploadFontSchema,
  addOverlayToolSchema,
  updateOverlayToolSchema,
  getOverlaysSchema,
  getPieceStateSchema,
  RemoveOverlaySchema,
  ReorderOverlaysSchema,
  createTemplateFromPieceSchema,
  applyTemplateSchema,
  publishTemplateSchema,
  audioAddClipSchema,
} from "@/mcp/tools/schemas";
import { applyTemplateAdvertisedSchema, publishTemplateAdvertisedSchema } from "@/mcp/tools/advertised-schemas";

/** Each tool's `inputSchema` exactly as `mcp/server.ts` passes it to `registerTool`. */
export const RUN_TOOL_INPUT_SCHEMAS = {
  "libi.trim_video": TrimVideoSchema.shape,
  "libi.add_overlay": addOverlayToolSchema,
  "libi.upload_font": UploadFontSchema.shape,
  "libi.update_overlay": updateOverlayToolSchema,
  "libi.get_overlays": getOverlaysSchema,
  "libi.get_piece_state": getPieceStateSchema.shape,
  "libi.remove_overlay": RemoveOverlaySchema,
  "libi.reorder_overlays": ReorderOverlaysSchema,
  "libi.create_template_from_piece": createTemplateFromPieceSchema,
  "libi.apply_template": applyTemplateAdvertisedSchema,
  "libi.publish_template": publishTemplateAdvertisedSchema,
  "libi.audio_add_clip": audioAddClipSchema,
} as const;

/** A tool that advertises a looser schema than it validates (mcp/tools/advertised-schemas.ts): the full one, run second. */
const RUN_TOOL_FULL_SCHEMAS: Partial<Record<RunToolName, z.ZodTypeAny>> = {
  "libi.apply_template": applyTemplateSchema,
  "libi.publish_template": publishTemplateSchema,
};

export type RunToolName = keyof typeof RUN_TOOL_INPUT_SCHEMAS;

/** The `CallToolResult` an agent gets for arguments its tool refuses. */
export interface ToolInputRefusal {
  content: [{ type: "text"; text: string }];
  isError: true;
}

export type ToolInputCheck =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; refusal: ToolInputRefusal };

/**
 * The SDK's `normalizeObjectSchema`, zod v3 only: a ZodObject as is, a raw
 * shape (`{ key: ZodType }`) wrapped in `z.object`, anything else undefined.
 */
export function toObjectSchema(schema: unknown): z.AnyZodObject | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const def = (schema as { _def?: { typeName?: string } })._def;
  if (!def) {
    const values = Object.values(schema);
    const allSchemas =
      values.length > 0 &&
      values.every((v) => typeof v === "object" && v !== null && ((v as { _def?: unknown })._def !== undefined || typeof (v as { parse?: unknown }).parse === "function"));
    return allSchemas ? z.object(schema as z.ZodRawShape) : undefined;
  }
  return (schema as { shape?: unknown }).shape !== undefined ? (schema as z.AnyZodObject) : undefined;
}

/** The SDK's `getParseErrorMessage`: a ZodError's `message` (its issues as JSON). */
export function parseErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    if ("message" in error && typeof (error as { message: unknown }).message === "string") {
      return (error as { message: string }).message;
    }
    const issues = (error as { issues?: Array<{ message?: unknown }> }).issues;
    if (Array.isArray(issues) && issues.length > 0 && issues[0] && typeof issues[0] === "object" && "message" in issues[0]) {
      return String(issues[0].message);
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
}

export async function validateToolInput(tool: RunToolName, args: unknown): Promise<ToolInputCheck> {
  const schema = coerceInputSchema(RUN_TOOL_INPUT_SCHEMAS[tool]);
  const obj = toObjectSchema(schema) ?? (schema as z.ZodTypeAny);
  let parsed = await obj.safeParseAsync(args);
  const full = RUN_TOOL_FULL_SCHEMAS[tool];
  if (parsed.success && full) parsed = await full.safeParseAsync(parsed.data);
  if (parsed.success) return { ok: true, args: parsed.data as Record<string, unknown> };
  const text = new McpError(
    ErrorCode.InvalidParams,
    `Input validation error: Invalid arguments for tool ${tool}: ${parseErrorMessage(parsed.error)}`,
  ).message;
  return { ok: false, refusal: { content: [{ type: "text", text }], isError: true } };
}

/**
 * Merged ("action") tools the route can run: `libi.<noun>` with an `action` (mcp/tools/action-tool.ts),
 * and the ONLY actions the e2e specs drive. The route runs the family's own action through the same
 * runner the MCP handler uses (`createActionRunner`: aliases, the action's schema, its `check`, its
 * handler), so a spec walks the agent's path and cannot drift from it. Any other action of the tool
 * (`libi.effect` `install_from_git` clones an arbitrary URL) is refused here; add one when a spec needs it.
 */
const RUN_ACTION_TOOLS: Readonly<Record<string, { def: ActionToolDef; actions: readonly string[] }>> = {
  "libi.template": { def: templateTool, actions: ["list", "delete"] },
  "libi.layer_effect": { def: layerEffectTool, actions: ["apply"] },
  "libi.effect": { def: effectTool, actions: ["add", "remove"] },
};

export function isRunActionTool(tool: string): boolean {
  return Object.hasOwn(RUN_ACTION_TOOLS, tool);
}

export type ActionToolRun =
  | { ok: true; result: unknown }
  | { ok: false; refusal: ToolInputRefusal };

const runners = new Map<string, ReturnType<typeof actionRunnerFor>>();

function refuse(text: string): { ok: false; refusal: ToolInputRefusal } {
  return { ok: false, refusal: { content: [{ type: "text", text }], isError: true } };
}

/** Run one action of a merged tool the route allows: the `action` must be one of the listed ones, then
 *  the family's own runner validates and runs it. A refusal is returned; a handler's throw propagates. */
export async function runActionTool(tool: string, args: Record<string, unknown>): Promise<ActionToolRun> {
  const entry = RUN_ACTION_TOOLS[tool];
  let runner = runners.get(tool);
  if (!runner) runners.set(tool, (runner = actionRunnerFor(entry.def)));
  const action = args[runner.discriminator];
  if (typeof action !== "string" || !entry.actions.includes(action)) {
    return refuse(`${tool} needs \`${runner.discriminator}\`: one of ${entry.actions.join(", ")}.`);
  }
  const { [runner.discriminator]: _picked, ...rest } = args;
  void _picked;
  const outcome = await runner.run(action, rest, undefined);
  return outcome.ok ? outcome : refuse(outcome.error);
}
