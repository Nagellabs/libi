/**
 * Merged ("action") tools: one `libi.<noun>` whose old per-verb tools became
 * values of a discriminator field. See docs-local/superpowers/plans/
 * 2026-10-02-tool-merge-spec.md for why (the name is the discovery key on both
 * clients; fewer, well-named tools cost less to list).
 *
 * WHAT THE MODEL SEES. A FLAT object schema — never a zod discriminatedUnion
 * (anyOf bloats the list and some clients strip it):
 *   - the discriminator (`action`, or `target` / `kind`) is the only REQUIRED
 *     property, an enum of the actions, its description naming each one;
 *   - every other property is the union of the actions' properties, all optional
 *     at the JSON-schema level, each described as
 *     `(actions that use it) <original text> Required for <actions>.` (no tag when every
 *     action takes it, no "for" when every action that takes it requires it) — Codex
 *     renders property descriptions as comments in the declaration it reads.
 *
 * WHAT RUNS. The advertised object is `.passthrough()` so the SDK's own
 * validation strips nothing, then the call is re-validated against the ACTION's
 * ORIGINAL zod schema (through `coerceInputSchema`, like any registered tool):
 * a strict original (`refuseUnknownFields`) still refuses unknown fields, a
 * stripping one still strips. The original handler runs unchanged, so results,
 * logging tags and job wiring are identical to the tool this replaced.
 *
 * GATES are declared per action (`gate`) and enforced here (no family declares one today; the
 * mechanism is exercised by action-tool.test.ts):
 *   - `surface`  the action is not advertised, and is refused, off that surface;
 *   - `check`    a per-call refusal on the validated arguments.
 *
 * APPROVAL IS NOT HERE. The extension approval gate (lib/approval/extensions.ts) and the agent's
 * remembered "don't ask again" are both keyed on the TOOL name, so nothing in this file can gate one
 * action of a merged tool. Two rules follow, held by data and tests rather than by this helper:
 * never merge an extension-gated verb with ungated ones (`__tests__/unit/mcp/merged-tool-risk.test.ts`
 * pins that the only merged tools an extension owns are the two tracking ones), and declare what each
 * action does in `MERGED_TOOL_RISK` (lib/agents/merged-tools.ts), which decides whether the chat offers
 * "don't ask again" for the tool.
 */
import { z } from "zod/v3";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toJsonSchemaCompat } from "@modelcontextprotocol/sdk/server/zod-json-schema-compat.js";
import type { AgentSurface } from "@/lib/mcp/agent-surface";
import { MERGED_TOOL_DISCRIMINATORS, isMergedToolName } from "@/lib/agents/merged-tools";
import { makeError } from "@/mcp/tool-error";
import { coerceInputSchema } from "@/mcp/tools/coerce-args";
import { LEGACY_INPUT_FIELDS } from "@/mcp/tools/legacy-inputs";
import { recordMergedTool } from "@/mcp/tools/action-registry";
import type { AnyToolResult } from "@/mcp/tools/types";

/** A result already in the MCP wire format (`{ content: [{ type: "text", text }] }`), which the
 *  skill and catalog tools return and the old registrations forwarded verbatim. Image blocks are
 *  allowed (the tracking spot-checks return frames); `isError` rides along when the tool set it. */
export type WireToolResult = {
  content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[];
  error?: string;
  isError?: boolean;
};

/** A tool's input as `schemas.ts` declares it: a ZodObject or a raw shape. */
export type ActionSchema = z.AnyZodObject | z.ZodRawShape;

type ParamsOf<S extends ActionSchema> = S extends z.ZodTypeAny
  ? z.infer<S>
  : S extends z.ZodRawShape
    ? z.infer<z.ZodObject<S>>
    : never;

export interface ActionGate {
  /** Advertised and callable only on this surface. */
  surface?: AgentSurface;
  /** Runs after validation; a returned string refuses the call with that text. */
  check?: (args: Record<string, unknown>) => string | null | Promise<string | null>;
}

export interface ActionDef<S extends ActionSchema = ActionSchema> {
  /** The ORIGINAL per-tool zod schema, reused as is. */
  schema: S;
  /** One line, shown in the discriminator's description. */
  describe: string;
  /** The original handler body: params in, tool result out (wrapping is the helper's). */
  run: (params: ParamsOf<S>, extra: unknown) => Promise<AnyToolResult | WireToolResult>;
  gate?: ActionGate;
  /** Extra per-property wording for THIS action, appended as `<action>: <note>`. */
  notes?: Record<string, string>;
  /** Appended to the refusal when the call fails validation, given the issues: for an action whose nested
   *  payload zod can only describe one layer at a time (a missing parent hides the children), the whole
   *  shape in one go. Return null when the issues are not about that payload. */
  invalidHint?: (issues: z.ZodIssue[]) => string | null;
  /** Names the action also accepts for one of its properties, `{ alias: property }` (a sibling action's
   *  spelling of the same thing). Moved onto the property before validation and never advertised. */
  aliases?: Record<string, string>;
}

/** Identity function that lets TypeScript infer `params` from `schema`. */
export function action<S extends ActionSchema>(def: ActionDef<S>): ActionDef {
  return def as unknown as ActionDef;
}

export interface ActionToolDef {
  /** Registered name, `libi.<noun>`. Must be in MERGED_TOOL_DISCRIMINATORS. */
  name: string;
  /** 1–2 sentences, keyword-rich, naming the actions. The only prose clients index. */
  description: string;
  actions: Record<string, ActionDef>;
  /** The surface this server was created for (`cli` when unknown). */
  surface?: AgentSurface;
  /** When two actions give one property different types: the type to advertise. */
  widen?: Record<string, z.ZodTypeAny>;
  /** Wording for a property that several actions describe differently (or not at all). Replaces the
   *  original texts; the `(actions)` tag and the `Required for …` note are still added. */
  props?: Record<string, string>;
}

/** The ACP session a call came from: `_meta.sessionId` (claude-agent-acp), else the transport's. "" when neither. */
export function sessionIdOf(extra: unknown): string {
  const e = extra as { _meta?: { sessionId?: string }; sessionId?: string } | undefined;
  return e?._meta?.sessionId ?? e?.sessionId ?? "";
}

function isZodObject(v: unknown): v is z.AnyZodObject {
  return typeof v === "object" && v !== null && (v as { _def?: { typeName?: string } })._def?.typeName === "ZodObject";
}

export function actionObject(schema: ActionSchema): z.AnyZodObject {
  return isZodObject(schema) ? schema : z.object(schema);
}

function typeNameOf(t: z.ZodTypeAny): string {
  return (t as unknown as { _def: { typeName: string } })._def.typeName;
}

/** The property type as advertised: optional, and without the original's default
 *  (the action's own schema applies defaults at call time, not the flat one). */
function advertisedType(t: z.ZodTypeAny): z.ZodTypeAny {
  let inner = t;
  while (typeNameOf(inner) === "ZodDefault") inner = (inner as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
  return inner.isOptional() ? inner : inner.optional();
}

function stripDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(stripDescriptions);
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>)
        .filter(([k]) => k !== "description")
        .map(([k, v]) => [k, stripDescriptions(v)]),
    );
  }
  return node;
}

/** The JSON shape of one property's TYPE (descriptions ignored), to tell "same type, different
 *  words" from "different types". */
function typeSignature(prop: string, t: z.ZodTypeAny): string {
  const json = toJsonSchemaCompat(z.object({ [prop]: advertisedType(t) }) as never, {
    strictUnions: true,
    pipeStrategy: "input",
  });
  return JSON.stringify(stripDescriptions((json as { properties?: Record<string, unknown> }).properties?.[prop]));
}

function descriptionOf(t: z.ZodTypeAny): string {
  let cur: z.ZodTypeAny | undefined = t;
  for (let i = 0; i < 6 && cur; i++) {
    const d = (cur as unknown as { description?: string }).description;
    if (d) return d.trim();
    cur = (cur as unknown as { _def: { innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny } })._def.innerType ??
      (cur as unknown as { _def: { schema?: z.ZodTypeAny } })._def.schema;
  }
  return "";
}

interface PropUse {
  action: string;
  type: z.ZodTypeAny;
  required: boolean;
  description: string;
}

/** The text of one flat property: who uses it, what it means per action, where it is required. */
function composeDescription(
  uses: PropUse[],
  allActions: string[],
  notes: Array<[string, string]>,
  override?: string,
): string {
  // A property every action takes needs no tag; the others name who uses them.
  const tag = uses.length === allActions.length ? "" : `(${uses.map((u) => u.action).join(", ")})`;
  const sentence = (t: string) => (/[.!?]\)?$/.test(t) ? t : `${t}.`);
  const groups = new Map<string, string[]>();
  for (const u of uses) {
    if (!u.description) continue;
    groups.set(u.description, [...(groups.get(u.description) ?? []), u.action]);
  }
  let base = "";
  if (override) base = sentence(override);
  else if (groups.size === 1) base = sentence([...groups.keys()][0]);
  else if (groups.size > 1) base = [...groups].map(([d, as]) => `${as.join("/")}: ${sentence(d)}`).join(" ");
  const required = uses.filter((u) => u.required).map((u) => u.action);
  const requiredNote =
    required.length === 0 ? "" : required.length === uses.length ? "Required." : `Required for ${required.join(", ")}.`;
  const noteText = notes.map(([a, n]) => `${a}: ${n}`).join(" ");
  return [tag, base, noteText, requiredNote].filter(Boolean).join(" ");
}

export interface FlatSchema {
  shape: z.ZodRawShape;
  /** Per action, the property names it advertises and which of them are required (in schema order). */
  perAction: Record<string, { accepted: string[]; required: string[] }>;
}

/** Build the advertised flat shape for `def`. Throws if two actions disagree on a property's type. */
export function buildFlatSchema(def: ActionToolDef, discriminator: string, advertised: string[]): FlatSchema {
  const hidden = new Set(LEGACY_INPUT_FIELDS[def.name] ?? []);
  const uses = new Map<string, PropUse[]>();
  const perAction: FlatSchema["perAction"] = {};
  for (const [name, a] of Object.entries(def.actions)) {
    const shape = actionObject(a.schema).shape as z.ZodRawShape;
    const accepted: string[] = [];
    const required: string[] = [];
    for (const [prop, type] of Object.entries(shape)) {
      if (prop === discriminator) {
        throw new Error(`${def.name}: action "${name}" has a property named "${discriminator}", the discriminator`);
      }
      const isRequired = !type.isOptional();
      // A hidden legacy field is still ACCEPTED (the action's own schema takes it) but is not named
      // anywhere the model reads, the refusal's "accepts:" list included.
      if (hidden.has(prop)) continue;
      accepted.push(prop);
      if (isRequired) required.push(prop);
      uses.set(prop, [...(uses.get(prop) ?? []), { action: name, type, required: isRequired, description: descriptionOf(type) }]);
    }
    perAction[name] = { accepted, required };
  }

  const allActions = Object.keys(def.actions);
  const shape: z.ZodRawShape = {};
  for (const [prop, propUses] of uses) {
    let type = def.widen?.[prop];
    if (!type) {
      const sigs = new Set(propUses.map((u) => typeSignature(prop, u.type)));
      if (sigs.size > 1) {
        throw new Error(
          `${def.name}: property "${prop}" has different types across actions (${propUses.map((u) => u.action).join(", ")}); ` +
            `rename it in one action or pass \`widen\` with the type to advertise.`,
        );
      }
      type = propUses[0].type;
    }
    const notes = Object.entries(def.actions)
      .filter(([, a]) => a.notes?.[prop])
      .map(([n, a]) => [n, a.notes![prop]] as [string, string]);
    shape[prop] = advertisedType(type).describe(composeDescription(propUses, allActions, notes, def.props?.[prop]));
  }

  const actionDoc = advertised.map((n) => `${n} = ${def.actions[n].describe}`).join("; ");
  return {
    shape: { [discriminator]: z.enum(advertised as [string, ...string[]]).describe(actionDoc), ...shape },
    perAction,
  };
}

function isWireResult(result: unknown): result is WireToolResult {
  return !!result && typeof result === "object" && Array.isArray((result as { content?: unknown }).content);
}

function makeContent(result: AnyToolResult | WireToolResult) {
  // A wire-format result goes out as the tool built it, never wrapped a second time.
  if (isWireResult(result)) return result;
  return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
}

/** A refusal of the call itself (unknown action, invalid arguments): the codebase's one tool-error
 *  shape, `{ success: false, error }` flagged `isError` (mcp/tool-error.ts#makeError). */
function refusal(error: string) {
  return makeError(new Error(error));
}

function issueText(issue: z.ZodIssue): string {
  const where = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
  return `${where}${issue.message}`;
}

/** What running one action came to: the handler's own result, or a refusal of the call itself. */
export type ActionOutcome =
  | { ok: true; result: AnyToolResult | WireToolResult }
  | { ok: false; error: string };

/** Runs one ALREADY CHOSEN action of a merged tool (the discriminator is not in `args`):
 *  aliases, then the action's own schema (coerced the way `installArgCoercion` coerces a registered
 *  tool), then its `check`, then its handler. The one path every caller takes, so the MCP handler and
 *  the e2e route (lib/e2e/run-tool-input.ts) cannot drift. Throws only what the handler throws. */
export type ActionRunner = (action: string, args: Record<string, unknown>, extra: unknown) => Promise<ActionOutcome>;

/** One argument problem, by property path (`""` for the arguments as a whole). */
export interface ActionArgIssue {
  path: string;
  message: string;
}

const validatorCache = new WeakMap<ActionToolDef, Map<string, z.AnyZodObject>>();

/** The action's own validator, built once: its schema, coerced the way a registered tool's is. */
function actionValidator(def: ActionToolDef, chosen: string): z.AnyZodObject {
  let byAction = validatorCache.get(def);
  if (!byAction) validatorCache.set(def, (byAction = new Map()));
  let validator = byAction.get(chosen);
  if (!validator) {
    validator = actionObject(coerceInputSchema(actionObject(def.actions[chosen].schema)) as z.AnyZodObject);
    byAction.set(chosen, validator);
  }
  return validator;
}

/** `args` with the action's accepted aliases moved onto their properties (a sibling action's spelling). */
function withAliases(act: ActionDef, args: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...args };
  for (const [alias, property] of Object.entries(act.aliases ?? {})) {
    if (!Object.hasOwn(rest, alias)) continue;
    if (!Object.hasOwn(rest, property)) rest[property] = rest[alias];
    delete rest[alias];
  }
  return rest;
}

/**
 * Validate `args` against ONE action's own schema WITHOUT running it (aliases, then the coerced schema:
 * exactly what `createActionRunner` does before the handler). For a caller that checks a whole list of
 * calls before running any (libi.apply_ops). `chosen` must be one of `def.actions`.
 */
export async function validateActionArgs(
  def: ActionToolDef,
  chosen: string,
  args: Record<string, unknown>,
): Promise<ActionArgIssue[]> {
  const parsed = await actionValidator(def, chosen).safeParseAsync(withAliases(def.actions[chosen], args));
  return parsed.success ? [] : parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
}

export function createActionRunner(def: ActionToolDef, discriminator: string, perAction: FlatSchema["perAction"]): ActionRunner {
  const validators = Object.fromEntries(
    Object.keys(def.actions).map((n) => [n, actionObject(coerceInputSchema(actionObject(def.actions[n].schema)) as z.AnyZodObject)]),
  ) as Record<string, z.AnyZodObject>;
  return async (chosen, args, extra) => {
    const act = def.actions[chosen];
    const rest = withAliases(act, args);
    const parsed = await validators[chosen].safeParseAsync(rest);
    if (!parsed.success) {
      const { accepted, required } = perAction[chosen];
      const hint = act.invalidHint?.(parsed.error.issues);
      return {
        ok: false,
        error:
          `${def.name}({ ${discriminator}: "${chosen}" }): invalid arguments. ${parsed.error.issues.map(issueText).join("; ")}. ` +
          `${chosen} requires: ${required.length ? required.join(", ") : "nothing"}; accepts: ${accepted.join(", ") || "nothing"}.` +
          (hint ? ` ${hint}` : ""),
      };
    }
    const refused = act.gate?.check ? await act.gate.check(parsed.data) : null;
    if (refused) return { ok: false, error: refused };
    return { ok: true, result: await act.run(parsed.data as never, extra) };
  };
}

/** An action runner for every declared action of `def`, for a caller that does not register a server
 *  (the e2e route). */
export function actionRunnerFor(def: ActionToolDef): { discriminator: string; actions: string[]; run: ActionRunner } {
  if (!isMergedToolName(def.name)) throw new Error(`${def.name} is not in MERGED_TOOL_DISCRIMINATORS`);
  const discriminator: string = MERGED_TOOL_DISCRIMINATORS[def.name];
  const actions = Object.keys(def.actions);
  return { discriminator, actions, run: createActionRunner(def, discriminator, buildFlatSchema(def, discriminator, actions).perAction) };
}

type RegisterToolFn = (name: string, config: Record<string, unknown>, cb: unknown) => unknown;

/**
 * Register one merged tool on `server`. Call it where the per-verb
 * `server.registerTool` calls used to be, so the analytics, tool-call-context
 * and arg-coercion wrappers installed on `server.registerTool` apply to it.
 */
export function registerActionTool(server: McpServer, def: ActionToolDef): void {
  if (!isMergedToolName(def.name)) {
    throw new Error(`${def.name} is not in MERGED_TOOL_DISCRIMINATORS (lib/agents/merged-tools.ts); add it there first.`);
  }
  const discriminator: string = MERGED_TOOL_DISCRIMINATORS[def.name];
  const surface: AgentSurface = def.surface ?? "cli";
  const allActions = Object.keys(def.actions);
  const advertised = allActions.filter((n) => !def.actions[n].gate?.surface || def.actions[n].gate!.surface === surface);
  if (advertised.length === 0) throw new Error(`${def.name}: no action is available on the ${surface} surface`);

  const flat = buildFlatSchema(def, discriminator, advertised);
  const inputSchema = z.object(flat.shape).passthrough();

  // Registry: the actions each merged tool declares, advertised or not (analytics bounds `action` by it).
  recordMergedTool(def.name, { discriminator, actions: allActions });

  const runAction = createActionRunner(def, discriminator, flat.perAction);

  const register = server.registerTool.bind(server) as unknown as RegisterToolFn;
  register(
    def.name,
    { description: def.description, inputSchema },
    async (args: Record<string, unknown>, extra: unknown) => {
      try {
        // Over MCP the SDK has already refused a missing, unknown or off-surface discriminator (it is a
        // required enum of the ADVERTISED actions: "Input validation error"), so these two refusals are
        // for a caller that reaches the handler without the SDK's check (tests, a future in-process caller).
        const chosen = args?.[discriminator];
        if (typeof chosen !== "string" || !Object.hasOwn(def.actions, chosen)) {
          return refusal(
            chosen === undefined
              ? `${def.name} needs \`${discriminator}\`: one of ${advertised.join(", ")}.`
              : `${def.name}: unknown ${discriminator} ${JSON.stringify(chosen)}. Use one of ${advertised.join(", ")}.`,
          );
        }
        const act = def.actions[chosen];
        if (act.gate?.surface && act.gate.surface !== surface) {
          return refusal(`${def.name}({ ${discriminator}: "${chosen}" }) is only available in the ${act.gate.surface} chat.`);
        }
        const { [discriminator]: _picked, ...rest } = args;
        void _picked;
        const outcome = await runAction(chosen, rest, extra);
        return outcome.ok ? makeContent(outcome.result) : refusal(outcome.error);
      } catch (err) {
        return makeError(err);
      }
    },
  );
}
