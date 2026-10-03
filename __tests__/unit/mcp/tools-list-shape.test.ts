import { createRequire } from "node:module";
import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod/v3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  ALWAYS_LOAD_META_KEY,
  ALWAYS_LOAD_TOOLS,
  IN_APP_ONLY_TOOLS,
} from "@/lib/mcp/agent-surface";
import { installToolsListShaping, rewriteTuples, shapeTool, shapeToolsList } from "@/mcp/tools-list-shape";
import { createLibiMcpServer } from "@/mcp/server";
import { createTrackingMcpServer } from "@/mcp/tracking-mcp/server";
import { createAggregateSession } from "@/mcp/http/session";

const base = (over: Partial<Tool> = {}): Tool => ({
  name: "libi.x",
  description: "d",
  inputSchema: { type: "object", properties: {} },
  ...over,
});

describe("shapeTool", () => {
  it("drops $schema from input and output schemas and leaves the rest alone", () => {
    const t = shapeTool(
      base({
        inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { a: { type: "string" } } } as Tool["inputSchema"],
        outputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object" } as Tool["outputSchema"],
      }),
      [],
    );
    expect(t.inputSchema).toEqual({ type: "object", properties: { a: { type: "string" } } });
    expect(t.outputSchema).toEqual({ type: "object" });
  });

  it("drops the default execution but keeps a non-default one", () => {
    expect(shapeTool(base({ execution: { taskSupport: "forbidden" } }), []).execution).toBeUndefined();
    expect("execution" in shapeTool(base({ execution: { taskSupport: "forbidden" } }), [])).toBe(false);
    expect(shapeTool(base({ execution: { taskSupport: "optional" } }), []).execution).toEqual({ taskSupport: "optional" });
    expect(shapeTool(base({ execution: { taskSupport: "required" } }), []).execution).toEqual({ taskSupport: "required" });
  });

  it("pins alwaysLoad tools, preserving existing _meta, and leaves others without the key", () => {
    const pinned = shapeTool(base({ name: "libi.a", _meta: { keep: 1 } }), ["libi.a"]);
    expect(pinned._meta).toEqual({ keep: 1, [ALWAYS_LOAD_META_KEY]: true });
    const other = shapeTool(base({ name: "libi.b", _meta: { keep: 1 } }), ["libi.a"]);
    expect(other._meta).toEqual({ keep: 1 });
    expect("_meta" in shapeTool(base({ name: "libi.c" }), ["libi.a"])).toBe(false);
  });

  it("does not mutate its input", () => {
    const input = base({ execution: { taskSupport: "forbidden" }, inputSchema: { $schema: "x", type: "object" } as Tool["inputSchema"] });
    const snapshot = JSON.parse(JSON.stringify(input));
    shapeToolsList([input], ["libi.x"]);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });
});

describe("installToolsListShaping on a real McpServer", () => {
  it("wraps the SDK handler: shaped over the wire, still callable", async () => {
    const server = new McpServer({ name: "t", version: "0" });
    server.registerTool(
      "libi.read_manual",
      { description: "m", inputSchema: { section: z.string().optional() } },
      async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    );
    server.registerTool("libi.other", { description: "o", inputSchema: {} }, async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    installToolsListShaping(server);
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await server.connect(s);
    await client.connect(c);
    const { tools } = await client.listTools();
    const raw = JSON.stringify(tools);
    expect(raw).not.toContain("$schema");
    expect(raw).not.toContain("taskSupport");
    expect(tools.find((t) => t.name === "libi.read_manual")?._meta).toEqual({ [ALWAYS_LOAD_META_KEY]: true });
    expect(tools.find((t) => t.name === "libi.other")?._meta).toBeUndefined();
    const res = await client.callTool({ name: "libi.other", arguments: {} });
    expect(res.isError).toBeFalsy();
    await client.close();
    await server.close();
  });

  it("is a no-op when nothing was registered", () => {
    expect(() => installToolsListShaping(new McpServer({ name: "t", version: "0" }))).not.toThrow();
  });
});

async function listVia(server: { connect: (t: never) => Promise<void>; close: () => Promise<void> }) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "c", version: "0" });
  await server.connect(s as never);
  await client.connect(c);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools;
}

describe("every transport serves the shaped list", () => {
  let direct: Tool[];
  beforeAll(async () => {
    direct = await listVia(createLibiMcpServer({ surface: "in-app" }));
  });

  it("createLibiMcpServer (the stdio entry and the aggregator's inner hop): no $schema, no default execution", () => {
    expect(direct.length).toBeGreaterThan(100);
    for (const t of direct) {
      expect(JSON.stringify(t.inputSchema)).not.toContain("$schema");
      expect(t.execution).toBeUndefined();
    }
  });

  it("the standalone tracking server", async () => {
    const tools = await listVia(createTrackingMcpServer());
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(JSON.stringify(t.inputSchema)).not.toContain("$schema");
      expect(t.execution).toBeUndefined();
    }
  });

  it("the streamable-HTTP aggregator session", async () => {
    const session = await createAggregateSession({ surface: "in-app", dialect: "claude", instructions: "x" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "c", version: "0" });
    await session.server.connect(s);
    await client.connect(c);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(direct.map((t) => t.name).sort());
    expect(JSON.stringify(tools)).not.toContain("$schema");
    expect(JSON.stringify(tools)).not.toContain("taskSupport");
    await client.close();
    await session.close();
  });
});

describe("ALWAYS_LOAD_TOOLS", () => {
  it("is short, and every name is a registered tool carrying the key (and no other tool does)", async () => {
    const tools = await listVia(createLibiMcpServer({ surface: "in-app" }));
    expect(ALWAYS_LOAD_TOOLS.length).toBeGreaterThan(0);
    expect(ALWAYS_LOAD_TOOLS.length).toBeLessThanOrEqual(6);
    const names = new Set(tools.map((t) => t.name));
    for (const n of ALWAYS_LOAD_TOOLS) expect(names.has(n), `${n} is not a registered tool`).toBe(true);
    const pinned = tools.filter((t) => t._meta?.[ALWAYS_LOAD_META_KEY] === true).map((t) => t.name);
    expect(pinned.sort()).toEqual([...ALWAYS_LOAD_TOOLS].sort());
  });

  it("pins exactly the hottest small tools: the manual, the piece list, the two state reads and show", () => {
    expect([...ALWAYS_LOAD_TOOLS].sort()).toEqual(
      ["libi.get_composition", "libi.get_piece_state", "libi.list_pieces", "libi.read_manual", "libi.show"],
    );
  });

  it.each(["in-app", "cli"] as const)("(%s) each pinned tool is small, and the set stays under 6 KB — they ride in every request", async (surface) => {
    const tools = await listVia(createLibiMcpServer({ surface }));
    let total = 0;
    for (const n of ALWAYS_LOAD_TOOLS) {
      const t = tools.find((x) => x.name === n)!;
      const bytes = JSON.stringify(t).length;
      expect(bytes, `${n} is ${bytes} B: trim it or take it off ALWAYS_LOAD_TOOLS`).toBeLessThanOrEqual(2500);
      total += bytes;
    }
    expect(total, `pinned tools total ${total} B`).toBeLessThanOrEqual(6000);
  });

  it("only pins tools that exist on the cli surface too, unless in-app-only by design", () => {
    for (const n of ALWAYS_LOAD_TOOLS) expect(IN_APP_ONLY_TOOLS).not.toContain(n);
  });
});

describe("rewriteTuples (draft-07 tuples must survive a 2020-12 reader)", () => {
  const num = { type: "number" };
  const tuple4 = { type: "array", items: [num, num, num, num], minItems: 4, maxItems: 4 };

  it("collapses a homogeneous tuple to one item schema with exact bounds", () => {
    expect(rewriteTuples(tuple4)).toEqual({ type: "array", items: num, minItems: 4, maxItems: 4 });
  });

  it("uses anyOf of the unique members for a mixed tuple", () => {
    const str = { type: "string" };
    expect(rewriteTuples({ type: "array", items: [num, str, num] })).toEqual({
      type: "array",
      items: { anyOf: [num, str] },
      minItems: 3,
      maxItems: 3,
    });
  });

  it("drops additionalItems; a schema-valued rest joins the item schema and lifts the cap", () => {
    expect(rewriteTuples({ type: "array", items: [num], additionalItems: false })).toEqual({
      type: "array",
      items: num,
      minItems: 1,
      maxItems: 1,
    });
    expect(rewriteTuples({ type: "array", items: [num], additionalItems: { type: "string" } })).toEqual({
      type: "array",
      items: { anyOf: [num, { type: "string" }] },
      minItems: 1,
    });
  });

  it("keeps existing minItems/maxItems", () => {
    expect(rewriteTuples({ type: "array", items: [num, num], minItems: 1, maxItems: 2 })).toMatchObject({
      minItems: 1,
      maxItems: 2,
    });
  });

  it("reaches tuples nested in properties, items, anyOf, additionalProperties, $defs, definitions, prefixItems", () => {
    const out = rewriteTuples({
      type: "object",
      properties: {
        a: { anyOf: [tuple4, { type: "null" }] },
        b: { type: "array", items: { type: "object", properties: { box: tuple4 } } },
      },
      additionalProperties: tuple4,
      $defs: { d: tuple4 },
      definitions: { e: tuple4 },
    });
    expect(JSON.stringify(out)).not.toMatch(/"items":\[/);
    expect(JSON.stringify(out)).not.toContain("additionalItems");
    const pi = rewriteTuples({ prefixItems: [tuple4] }) as { prefixItems: Array<{ items: unknown }> };
    expect(pi.prefixItems[0]!.items).toEqual(num);
  });

  it("does not mistake data for schema (a property NAMED items, enum values)", () => {
    const input = {
      type: "object",
      properties: { items: { type: "array", items: { type: "string" } } },
      enum: [{ items: [1, 2] }],
      default: { items: [1, 2] },
    };
    expect(rewriteTuples(input)).toEqual(input);
  });

  it("never mutates its input and is idempotent", () => {
    const input = { type: "object", properties: { box: tuple4 } };
    const snapshot = JSON.parse(JSON.stringify(input));
    const once = rewriteTuples(input);
    expect(input).toEqual(snapshot);
    expect(rewriteTuples(once)).toEqual(once);
  });

  it("shapeTool rewrites input and output schemas", () => {
    const t = shapeTool(
      base({
        inputSchema: { type: "object", properties: { box: tuple4 } } as Tool["inputSchema"],
        outputSchema: { type: "object", properties: { box: tuple4 } } as Tool["outputSchema"],
      }),
      [],
    );
    expect(JSON.stringify(t)).not.toMatch(/"items":\[/);
  });
});

/** JSON Schema 2020-12 compiler from the SDK's own ajv (resolved from the SDK, so hoisting does not matter). */
function ajv2020(): { compile: (s: unknown) => unknown } {
  const req = createRequire(require.resolve("@modelcontextprotocol/sdk/package.json"));
  const Ajv2020 = req("ajv/dist/2020").default as new (o: object) => { compile: (s: unknown) => unknown };
  return new Ajv2020({ strict: false, allErrors: false });
}

function findArrayItems(node: unknown, path: string, hits: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => findArrayItems(v, `${path}[${i}]`, hits));
  } else if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) {
      if ((k === "items" && Array.isArray(v)) || k === "additionalItems") hits.push(`${path}.${k}`);
      findArrayItems(v, `${path}.${k}`, hits);
    }
  }
}

describe("every served tool schema is valid JSON Schema 2020-12 (Claude Code drops a tool whose schema is not)", () => {
  for (const surface of ["in-app", "cli"] as const) {
    it(`${surface} surface: inputSchema and outputSchema compile; no draft-07 tuple keywords remain`, async () => {
      const tools = await listVia(createLibiMcpServer({ surface }));
      expect(tools.length).toBeGreaterThan(100);
      const ajv = ajv2020();
      const failures: string[] = [];
      for (const t of tools) {
        for (const [which, schema] of [["inputSchema", t.inputSchema], ["outputSchema", t.outputSchema]] as const) {
          if (!schema) continue;
          const hits: string[] = [];
          findArrayItems(schema, which, hits);
          if (hits.length) failures.push(`${t.name}: draft-07 tuple keyword at ${hits.join(", ")}`);
          try {
            ajv.compile(schema);
          } catch (e) {
            failures.push(`${t.name} ${which}: ${(e as Error).message}`);
          }
        }
      }
      expect(failures).toEqual([]);
    });
  }

  it("a tuple tool still enforces the exact tuple at call time (the rewrite is advisory to the client only)", async () => {
    const server = createLibiMcpServer({ surface: "in-app" });
    const client = new Client({ name: "c", version: "0" });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(s), client.connect(c)]);
    try {
      const listed = (await client.listTools()).tools.find((t) => t.name === "libi.analysis_query");
      const tr = (listed?.inputSchema.properties as Record<string, { minItems?: number; maxItems?: number }>).time_range;
      expect(tr).toMatchObject({ minItems: 2, maxItems: 2 });
      const outcome = await client
        .callTool({ name: "libi.analysis_query", arguments: { action: "search_frames", fileId: "f", query: "q", time_range: [1] } })
        .then((r) => ({ isError: r.isError, text: JSON.stringify(r.content) }))
        .catch((e: Error) => ({ isError: true, text: e.message }));
      expect(outcome.isError).toBe(true);
      expect(outcome.text).toMatch(/time_range/);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
