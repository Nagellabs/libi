/**
 * The `OpInvoker` `libi.apply_ops` runs its ops through: the REGISTERED tools of the server it lives on.
 *
 * A registered tool is `{ inputSchema, handler }` as the SDK stores it, after every wrapper
 * `createLibiMcpServer` installed (argument coercion, analytics, tool-call context). Calling that handler
 * is calling the tool: same validation (the SDK would parse the arguments with `inputSchema`; this does
 * the same), same handler body, same result text. A merged tool is validated per ACTION against that
 * action's own schema (`validateActionArgs`), exactly as `registerActionTool` does before its handler runs.
 */
import { MERGED_TOOL_DISCRIMINATORS, isMergedToolName } from "@/lib/agents/merged-tools";
import { validateActionArgs, type ActionToolDef } from "@/mcp/tools/action-tool";
import type { ArgIssue, OpInvoker, OpOutcome } from "@/mcp/tools/apply-ops";

/** The slice of the SDK's `RegisteredTool` this needs. */
export interface RegisteredToolLike {
  inputSchema?: unknown;
  handler: (...args: never[]) => unknown;
}

interface SafeParsing {
  safeParseAsync(input: unknown): Promise<{ success: true; data: unknown } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } }>;
}

const hasSafeParse = (v: unknown): v is SafeParsing => typeof (v as SafeParsing | undefined)?.safeParseAsync === "function";

function issuesOf(error: { issues: { path: (string | number)[]; message: string }[] }): ArgIssue[] {
  return error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

/** The handler's wire result, as an outcome: its JSON text parsed, `success: false` and `isError` both failures. */
function outcomeOf(result: unknown): OpOutcome {
  const wire = result as { content?: { type: string; text?: string }[]; isError?: boolean } | undefined;
  const text = wire?.content?.find((c) => c.type === "text")?.text;
  let body: Record<string, unknown> | undefined;
  if (typeof text === "string") {
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
    } catch {
      // not JSON: handled below
    }
  }
  const failed = wire?.isError === true || body?.success === false;
  const data = body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? (body.data as Record<string, unknown>) : undefined;
  if (!failed) return { ok: true, ...(data ? { data } : {}) };
  const error = typeof body?.error === "string" ? body.error : (text ?? "the op failed");
  const hint = [data?.hint, data?.message].find((v): v is string => typeof v === "string");
  return { ok: false, error, ...(hint ? { hint } : {}), ...(data ? { data } : {}) };
}

export function createOpInvoker(
  registered: ReadonlyMap<string, RegisteredToolLike>,
  mergedDefs: readonly ActionToolDef[],
): OpInvoker {
  const mergedByName = new Map(mergedDefs.map((d) => [d.name, d]));
  const find = (tool: string): RegisteredToolLike => {
    const rt = registered.get(tool);
    if (!rt) throw new Error(`${tool} is not registered on this server`);
    return rt;
  };
  return {
    async validate(tool, action, args) {
      if (isMergedToolName(tool)) {
        const def = mergedByName.get(tool);
        if (!def || !action || !Object.hasOwn(def.actions, action)) return [{ path: "action", message: `unknown action ${JSON.stringify(action)}` }];
        return validateActionArgs(def, action, args);
      }
      const schema = find(tool).inputSchema;
      if (!hasSafeParse(schema)) return [];
      const parsed = await schema.safeParseAsync(args);
      return parsed.success ? [] : issuesOf(parsed.error);
    },
    async call(tool, action, args, extra) {
      const rt = find(tool);
      let payload: Record<string, unknown> = args;
      if (isMergedToolName(tool)) payload = { [MERGED_TOOL_DISCRIMINATORS[tool]]: action, ...args };
      if (hasSafeParse(rt.inputSchema)) {
        const parsed = await rt.inputSchema.safeParseAsync(payload);
        if (!parsed.success) {
          return { ok: false, error: issuesOf(parsed.error).map((i) => `${i.path ? `${i.path}: ` : ""}${i.message}`).join("; ") };
        }
        payload = parsed.data as Record<string, unknown>;
      }
      return outcomeOf(await (rt.handler as (a: unknown, e: unknown) => unknown)(payload, extra));
    },
  };
}
