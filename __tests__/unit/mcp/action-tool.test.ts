/**
 * `registerActionTool` (mcp/tools/action-tool.ts): the shared machinery behind every merged tool.
 *
 * The fake families here borrow real merged-tool NAMES (`libi.job`, `libi.show`, …) because the
 * helper refuses a name that is not in lib/agents/merged-tools.ts; nothing of the real families
 * is used. The real families are held to the real server in merged-tools-families.test.ts.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod/v3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { action, registerActionTool, type ActionToolDef } from "@/mcp/tools/action-tool";
import { boundedActionOf } from "@/mcp/tools/action-registry";
import { installArgCoercion } from "@/mcp/tools/coerce-args";
import { shapeTool } from "@/mcp/tools-list-shape";
import { wrapRegisterToolWithTracking } from "@/mcp/analytics";
import { mergedToolAction } from "@/lib/agents/merged-tools";

const ok = (data: Record<string, unknown> = {}) => ({ success: true as const, data });

/** A strict schema in the style of schemas.ts#refuseUnknownFields: unknown keys are REFUSED with words. */
const strictAdd = z
  .object(
    { pieceId: z.string(), label: z.string() },
    {
      errorMap: (issue, ctx) =>
        issue.code === z.ZodIssueCode.unrecognized_keys
          ? { message: `Unknown field: ${issue.keys.join(", ")} — nothing was changed.` }
          : { message: ctx.defaultError },
    },
  )
  .strict();

function fakeJob(overrides: Partial<ActionToolDef> = {}) {
  const calls: Array<{ action: string; params: unknown }> = [];
  const def: ActionToolDef = {
    name: "libi.job",
    description: "Fake merged tool. Actions: add, remove, nudge.",
    actions: {
      add: action({
        describe: "add one",
        schema: strictAdd,
        run: async (params) => {
          calls.push({ action: "add", params });
          return ok({ added: params.label });
        },
      }),
      remove: action({
        describe: "remove one",
        // a plain raw shape, as showFolderSchema is: stripping, not strict
        schema: { pieceId: z.string().describe("The piece."), label: z.string().describe("The label to remove."), limit: z.number().default(7) },
        run: async (params) => {
          calls.push({ action: "remove", params });
          return ok({ removed: params.label, limit: params.limit });
        },
      }),
      nudge: action({
        describe: "nudge",
        schema: z.object({ pieceId: z.string(), by: z.number().optional().describe("Distance.") }),
        run: async (params) => {
          calls.push({ action: "nudge", params });
          return ok();
        },
      }),
    },
    ...overrides,
  };
  return { def, calls };
}

async function connect(def: ActionToolDef, surface: "cli" | "in-app" = "cli") {
  const server = new McpServer({ name: "t", version: "0" });
  installArgCoercion(server);
  registerActionTool(server, { ...def, surface });
  const client = new Client({ name: "c", version: "0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(s), client.connect(c)]);
  return {
    client,
    tools: async (): Promise<Tool[]> => (await client.listTools()).tools,
    call: async (args: Record<string, unknown>) => {
      const res = await client.callTool({ name: def.name, arguments: args });
      const text = (res.content as Array<{ text: string }>)[0].text;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let json: Record<string, any> | null = null;
      try {
        json = JSON.parse(text);
      } catch {
        // an SDK-level refusal is plain text
      }
      return { isError: !!res.isError, text, json };
    },
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

/** The registered handler, for calls that never go through the SDK's own enum check. */
function captureHandler(def: ActionToolDef, surface: "cli" | "in-app") {
  let handler!: (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  const server = { registerTool: (_n: string, _c: unknown, cb: typeof handler) => void (handler = cb) } as unknown as McpServer;
  registerActionTool(server, { ...def, surface });
  return handler;
}

describe("the advertised schema is flat", () => {
  it("has `action` as the only required property, an enum of the actions, and the union of every action's properties", async () => {
    const h = await connect(fakeJob().def);
    const [tool] = await h.tools();
    const schema = tool.inputSchema as { required?: string[]; properties: Record<string, { enum?: string[]; description: string }>; anyOf?: unknown; oneOf?: unknown };
    expect(schema.required).toEqual(["action"]);
    expect(schema.properties.action.enum).toEqual(["add", "remove", "nudge"]);
    expect(Object.keys(schema.properties).sort()).toEqual(["action", "by", "label", "limit", "pieceId"]);
    expect(schema.anyOf).toBeUndefined();
    expect(schema.oneOf).toBeUndefined();
    expect(JSON.stringify(schema)).not.toMatch(/anyOf|oneOf|discriminator/);
    await h.close();
  });

  it("describes each action on `action`, and each property by who uses it and where it is required", async () => {
    const h = await connect(fakeJob().def);
    const props = ((await h.tools())[0].inputSchema as { properties: Record<string, { description: string }> }).properties;
    expect(props.action.description).toBe("add = add one; remove = remove one; nudge = nudge");
    expect(props.pieceId.description).toBe("The piece. Required.");
    // used by add + remove, required in both, the two actions word it differently / not at all
    expect(props.label.description).toBe("(add, remove) The label to remove. Required.");
    // optional in nudge: no "Required"
    expect(props.by.description).toBe("(nudge) Distance.");
    // a default is the action's business, not the flat schema's
    expect(props.limit).not.toHaveProperty("default");
    expect(props.limit.description).toBe("(remove)");
    await h.close();
  });

  it("states per-action requiredness when it differs, and keeps both meanings when the words differ", async () => {
    const def: ActionToolDef = {
      name: "libi.keyframe",
      description: "x",
      actions: {
        a: action({ describe: "a", schema: z.object({ id: z.string().describe("Meaning one.") }), run: async () => ok() }),
        b: action({ describe: "b", schema: z.object({ id: z.string().optional().describe("Meaning two.") }), run: async () => ok() }),
        c: action({ describe: "c", schema: z.object({ id: z.string().describe("Meaning one.") }), run: async () => ok() }),
      },
    };
    const h = await connect(def);
    const props = ((await h.tools())[0].inputSchema as { properties: Record<string, { description: string }> }).properties;
    expect(props.id.description).toBe("a/c: Meaning one. b: Meaning two. Required for a, c.");
    await h.close();
  });

  it("a description that ends in a closing parenthesis is still a sentence: \"(typically music).\", not \"(typically music) Required.\"", async () => {
    const def: ActionToolDef = {
      name: "libi.keyframe",
      description: "x",
      actions: {
        a: action({ describe: "a", schema: z.object({ kind: z.string().describe("What it is (typically music)") }), run: async () => ok() }),
        b: action({ describe: "b", schema: z.object({ kind: z.string().describe("Already ends. (typically music).") }), run: async () => ok() }),
      },
    };
    const h = await connect(def);
    const props = ((await h.tools())[0].inputSchema as { properties: Record<string, { description: string }> }).properties;
    expect(props.kind.description).toBe("a: What it is (typically music). b: Already ends. (typically music). Required.");
    await h.close();
  });

  it("is advertised with additionalProperties false once shaped, like the per-verb tools it replaced", async () => {
    const h = await connect(fakeJob().def);
    const raw = (await h.tools())[0];
    expect(raw.inputSchema.additionalProperties).toBe(true); // passthrough, so the SDK strips nothing
    expect(shapeTool(raw, []).inputSchema.additionalProperties).toBe(false);
    await h.close();
  });

  it("refuses to merge two actions that give one property different types, unless told what to advertise", () => {
    const clash = (widen?: ActionToolDef["widen"]): ActionToolDef => ({
      name: "libi.keyframe",
      description: "x",
      widen,
      actions: {
        a: action({ describe: "a", schema: z.object({ v: z.string() }), run: async () => ok() }),
        b: action({ describe: "b", schema: z.object({ v: z.number() }), run: async () => ok() }),
      },
    });
    const server = new McpServer({ name: "t", version: "0" });
    expect(() => registerActionTool(server, clash())).toThrow(/property "v" has different types/);
    expect(() => registerActionTool(new McpServer({ name: "t", version: "0" }), clash({ v: z.union([z.string(), z.number()]) }))).not.toThrow();
  });

  it("refuses a name that is not a declared merged tool", () => {
    const { def } = fakeJob({ name: "libi.not_declared" });
    expect(() => registerActionTool(new McpServer({ name: "t", version: "0" }), def)).toThrow(/MERGED_TOOL_DISCRIMINATORS/);
  });

  it("uses the declared discriminator (`target` for libi.show)", async () => {
    const def: ActionToolDef = {
      name: "libi.show",
      description: "x",
      actions: { piece: action({ describe: "p", schema: z.object({ pieceId: z.string() }), run: async (p) => ok({ shown: p.pieceId }) }) },
    };
    const h = await connect(def);
    const schema = (await h.tools())[0].inputSchema as { required?: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(["target"]);
    expect(Object.keys(schema.properties)).toContain("target");
    expect((await h.call({ target: "piece", pieceId: "p1" })).json).toMatchObject({ success: true, data: { shown: "p1" } });
    await h.close();
  });
});

describe("a call is re-validated against the ACTION's original schema", () => {
  it("runs the original handler with the parsed arguments and wraps its result like any tool", async () => {
    const { def, calls } = fakeJob();
    const h = await connect(def);
    const res = await h.call({ action: "add", pieceId: "p", label: "x" });
    expect(res).toMatchObject({ isError: false, json: { success: true, data: { added: "x" } } });
    expect(calls).toEqual([{ action: "add", params: { pieceId: "p", label: "x" } }]);
    await h.close();
  });

  it("keeps a STRICT original strict: an unknown field is refused with the original's own words and nothing runs", async () => {
    const { def, calls } = fakeJob();
    const h = await connect(def);
    const res = await h.call({ action: "add", pieceId: "p", label: "x", drawFunction: "…" });
    expect(res.isError).toBe(true);
    expect(res.json?.error).toContain("Unknown field: drawFunction — nothing was changed.");
    expect(calls).toEqual([]);
    await h.close();
  });

  it("keeps a STRIPPING original stripping: a field of another action is dropped, not refused", async () => {
    const { def, calls } = fakeJob();
    const h = await connect(def);
    // `by` belongs to nudge; `remove` strips unknown keys, so it is dropped silently, as before the merge
    const res = await h.call({ action: "remove", pieceId: "p", label: "x", by: 5 });
    expect(res.isError).toBe(false);
    expect(calls).toEqual([{ action: "remove", params: { pieceId: "p", label: "x", limit: 7 } }]);
    await h.close();
  });

  it("applies the action's own defaults and arg coercion (a stringified number still parses)", async () => {
    const { def, calls } = fakeJob();
    const h = await connect(def);
    await h.call({ action: "remove", pieceId: "p", label: "x", limit: "3" });
    expect(calls[0].params).toMatchObject({ limit: 3 });
    await h.close();
  });

  it("names the action and its required fields when an argument is missing", async () => {
    const { def, calls } = fakeJob();
    const h = await connect(def);
    const res = await h.call({ action: "add", pieceId: "p" });
    expect(res.isError).toBe(true);
    expect(res.json?.error).toContain('libi.job({ action: "add" }): invalid arguments');
    expect(res.json?.error).toContain("label: Required");
    expect(res.json?.error).toContain("add requires: pieceId, label; accepts: pieceId, label.");
    // The codebase's one tool-error shape (mcp/tool-error.ts#makeError): { success:false, error } and nothing else.
    expect(Object.keys(res.json ?? {}).sort()).toEqual(["error", "success"]);
    expect(res.json?.success).toBe(false);
    expect(calls).toEqual([]);
    await h.close();
  });

  it("refuses bad calls in exactly the shape a thrown tool error has", async () => {
    const def = fakeJob().def;
    def.actions.nudge = action({ describe: "n", schema: z.object({ pieceId: z.string() }), run: async () => { throw new Error("boom"); } });
    const handler = captureHandler(def, "cli");
    const thrown = await handler({ action: "nudge", pieceId: "p" }, {});
    for (const args of [{ pieceId: "p" }, { action: "explode" }, { action: "add", pieceId: "p" }]) {
      const refused = await handler(args, {});
      expect(refused.isError, JSON.stringify(args)).toBe(true);
      const body = JSON.parse(refused.content[0].text);
      expect(Object.keys(body).sort(), JSON.stringify(args)).toEqual(Object.keys(JSON.parse(thrown.content[0].text)).sort());
      expect(typeof body.error).toBe("string");
    }
  });

  it("accepts an action's declared alias for one of its properties, and never advertises it", async () => {
    const seen = vi.fn();
    const def: ActionToolDef = {
      name: "libi.extension",
      description: "x",
      actions: {
        diagnose: action({ describe: "d", schema: z.object({ mcpId: z.string() }), run: async (p) => ok({ p }) }),
        update: action({
          describe: "u",
          schema: z.object({ id: z.string(), requireApproval: z.boolean().optional() }),
          aliases: { mcpId: "id" },
          run: async (p) => (seen(p), ok({ p })),
        }),
      },
    };
    const h = await connect(def);
    const props = Object.keys((await h.tools())[0].inputSchema.properties as object).sort();
    expect(props).toEqual(["action", "id", "mcpId", "requireApproval"]);
    // the alias carries the value; the action's schema sees only its own name
    const viaAlias = await h.call({ action: "update", mcpId: "libi-tracking", requireApproval: true });
    expect(viaAlias.json).toMatchObject({ success: true, data: { p: { id: "libi-tracking", requireApproval: true } } });
    expect(seen).toHaveBeenLastCalledWith({ id: "libi-tracking", requireApproval: true });
    // the canonical name wins when both arrive, and neither missing is still a named refusal
    await h.call({ action: "update", id: "a", mcpId: "b" });
    expect(seen).toHaveBeenLastCalledWith({ id: "a" });
    const missing = await h.call({ action: "update" });
    expect(missing.isError).toBe(true);
    expect(missing.json?.error).toContain("update requires: id");
    // another action that does not declare the alias still treats it as its own property
    expect((await h.call({ action: "diagnose", mcpId: "x" })).json).toMatchObject({ data: { p: { mcpId: "x" } } });
    await h.close();
  });

  it("sends a wire-format result with image blocks as the tool built it", async () => {
    const def: ActionToolDef = {
      name: "libi.job",
      description: "x",
      actions: {
        a: action({
          describe: "a",
          schema: z.object({}),
          run: async () => ({
            content: [
              { type: "image", data: "AAAA", mimeType: "image/png" },
              { type: "text", text: JSON.stringify({ success: true }) },
            ],
          }),
        }),
      },
    };
    const handler = captureHandler(def, "cli");
    const res = (await handler({ action: "a" }, {})) as unknown as { content: Array<{ type: string }> };
    expect(res.content.map((b) => b.type)).toEqual(["image", "text"]);
  });

  it("answers a missing or unknown action by listing the valid ones", async () => {
    const handler = captureHandler(fakeJob().def, "cli");
    const none = JSON.parse((await handler({ pieceId: "p" }, {})).content[0].text);
    expect(none.error).toBe("libi.job needs `action`: one of add, remove, nudge.");
    const bad = JSON.parse((await handler({ action: "explode" }, {})).content[0].text);
    expect(bad.error).toBe('libi.job: unknown action "explode". Use one of add, remove, nudge.');
    // an inherited name is not an action
    expect(JSON.parse((await handler({ action: "toString" }, {})).content[0].text).error).toContain("unknown action");
  });

  it("maps a throwing handler to the standard error result", async () => {
    const def = fakeJob().def;
    def.actions.nudge = action({ describe: "n", schema: z.object({ pieceId: z.string() }), run: async () => { throw new Error("boom"); } });
    const handler = captureHandler(def, "cli");
    const res = await handler({ action: "nudge", pieceId: "p" }, {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text)).toEqual({ success: false, error: "boom" });
  });

  it("passes the SDK's `extra` through to the handler", async () => {
    const seen = vi.fn();
    const def: ActionToolDef = {
      name: "libi.job",
      description: "x",
      actions: { a: action({ describe: "a", schema: z.object({}), run: async (_p, extra) => (seen(extra), ok()) }) },
    };
    const handler = captureHandler(def, "cli");
    const extra = { _meta: { "claudecode/toolUseId": "toolu_1" } };
    await handler({ action: "a" }, extra);
    expect(seen).toHaveBeenCalledWith(extra);
  });
});

describe("hidden legacy fields", () => {
  it("are accepted by the action but never advertised (LEGACY_INPUT_FIELDS keyed by the merged name)", async () => {
    const def: ActionToolDef = {
      name: "libi.audio_duck",
      description: "x",
      actions: {
        enable: action({
          describe: "e",
          schema: z.object({ clipId: z.string(), sidechainClipIds: z.array(z.string()).optional(), sidechainClipId: z.string().optional() }),
          run: async (p) => ok({ p }),
        }),
      },
    };
    const h = await connect(def);
    const props = Object.keys((await h.tools())[0].inputSchema.properties as object);
    expect(props).not.toContain("sidechainClipId");
    expect(props).toContain("sidechainClipIds");
    expect((await h.call({ action: "enable", clipId: "c", sidechainClipId: "vo" })).json).toMatchObject({ success: true, data: { p: { sidechainClipId: "vo" } } });
    await h.close();
  });
});

describe("per-action gates", () => {
  const gated = (check?: (a: Record<string, unknown>) => string | null) => {
    const run = vi.fn(async () => ok({ ran: true }));
    const def: ActionToolDef = {
      name: "libi.show",
      description: "x",
      actions: {
        open: action({ describe: "open", schema: z.object({ id: z.string() }), run }),
        chat: action({ describe: "chat only", schema: z.object({ id: z.string() }), run, gate: { surface: "in-app" } }),
        careful: action({ describe: "guarded", schema: z.object({ on: z.boolean() }), run, gate: { check } }),
      },
    };
    return { def, run };
  };

  it("an in-app action is advertised on the in-app surface and not on cli", async () => {
    const inApp = await connect(gated().def, "in-app");
    expect(((await inApp.tools())[0].inputSchema.properties as { target: { enum: string[] } }).target.enum).toEqual(["open", "chat", "careful"]);
    await inApp.close();
    const cli = await connect(gated().def, "cli");
    expect(((await cli.tools())[0].inputSchema.properties as { target: { enum: string[] } }).target.enum).toEqual(["open", "careful"]);
    // …and the SDK refuses it before the handler is reached
    const res = await cli.call({ target: "chat", id: "x" });
    expect(res.isError).toBe(true);
    await cli.close();
  });

  it("refuses an in-app action called on cli even when the call reaches the handler", async () => {
    const { def, run } = gated();
    const handler = captureHandler(def, "cli");
    const res = await handler({ target: "chat", id: "x" }, {});
    expect(res.isError).toBe(true);
    expect(JSON.parse(res.content[0].text).error).toBe('libi.show({ target: "chat" }) is only available in the in-app chat.');
    expect(run).not.toHaveBeenCalled();
    // …and runs it on in-app
    expect((await captureHandler(def, "in-app")({ target: "chat", id: "x" }, {})).isError).toBeUndefined();
    expect(run).toHaveBeenCalledOnce();
  });

  it("a `check` runs on the VALIDATED arguments and a refusal stops the handler", async () => {
    const check = vi.fn((a: Record<string, unknown>) => (a.on === false ? "may only turn this ON" : null));
    const { def, run } = gated(check);
    const handler = captureHandler(def, "cli");
    const refused = await handler({ target: "careful", on: false }, {});
    expect(refused.isError).toBe(true);
    expect(JSON.parse(refused.content[0].text)).toMatchObject({ success: false, error: "may only turn this ON" });
    expect(run).not.toHaveBeenCalled();
    await handler({ target: "careful", on: true }, {});
    expect(run).toHaveBeenCalledOnce();
    // an invalid call never reaches the check
    check.mockClear();
    await handler({ target: "careful", on: "nope" }, {});
    expect(check).not.toHaveBeenCalled();
  });
});

describe("analytics: tool_used carries a bounded action", () => {
  const register = () => {
    const calls: unknown[][] = [];
    const tracker = vi.fn();
    const wrapped = wrapRegisterToolWithTracking((...args: unknown[]) => void calls.push(args), tracker);
    return { calls, tracker, wrapped };
  };

  it("passes the action of a merged tool as the tracker's second argument", async () => {
    registerActionTool(new McpServer({ name: "t", version: "0" }), fakeJob().def);
    const { calls, tracker, wrapped } = register();
    wrapped("libi.job", {}, async () => "ok");
    await (calls[0][2] as (a: unknown) => Promise<unknown>)({ action: "remove", pieceId: "p" });
    expect(tracker).toHaveBeenCalledWith("libi.job", "remove");
  });

  it("collapses an action the tool does not declare to 'invalid' (no free-text cardinality)", async () => {
    registerActionTool(new McpServer({ name: "t", version: "0" }), fakeJob().def);
    const { calls, tracker, wrapped } = register();
    wrapped("libi.job", {}, async () => "ok");
    await (calls[0][2] as (a: unknown) => Promise<unknown>)({ action: "made_up" });
    expect(tracker).toHaveBeenCalledWith("libi.job", "invalid");
    expect(boundedActionOf("libi.job", { action: "Not A Shape!" })).toBeUndefined();
    expect(boundedActionOf("libi.job", { action: 5 })).toBeUndefined();
    expect(boundedActionOf("libi.job", {})).toBeUndefined();
  });

  it("an ordinary tool is tracked by name alone", async () => {
    const { calls, tracker, wrapped } = register();
    wrapped("libi.list_pieces", {}, async () => "ok");
    await (calls[0][2] as (a: unknown) => Promise<unknown>)({ action: "remove" });
    expect(tracker).toHaveBeenCalledWith("libi.list_pieces");
    expect(mergedToolAction("libi.list_pieces", { action: "remove" })).toBeNull();
  });
});
