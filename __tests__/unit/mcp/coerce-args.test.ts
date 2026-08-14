import { describe, it, expect } from "vitest";
import { z } from "zod/v3";
import { zodToJsonSchema } from "zod-to-json-schema";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { coerceInputSchema, installArgCoercion } from "@/mcp/tools/coerce-args";

/**
 * Regression for the systemic "Expected object/array/number, received string"
 * failures observed when the Claude Code ACP client sends typed tool args as
 * stringified JSON. `coerceInputSchema` parses such strings into the declared
 * type before validation, without corrupting genuine string fields — and
 * preserves the schema's emitted JSON shape (the SDK only emits JSON schema for
 * raw shapes / ZodObjects, never ZodEffects).
 */

describe("coerceInputSchema (pure)", () => {
  it("coerces stringified number / object / array on a raw shape; leaves strings", () => {
    const shape = {
      width: z.number(),
      meta: z.object({ a: z.number() }),
      tags: z.array(z.string()),
      name: z.string(),
    };
    const coerced = coerceInputSchema(shape) as Record<string, z.ZodTypeAny>;
    const obj = z.object(coerced);

    const out = obj.parse({
      width: "720",
      meta: '{"a":1}',
      tags: '["x","y"]',
      name: "hello", // genuine string, untouched
    });
    expect(out).toEqual({ width: 720, meta: { a: 1 }, tags: ["x", "y"], name: "hello" });
  });

  it("passes through already-correct (non-string) values unchanged", () => {
    const obj = z.object(
      coerceInputSchema({ width: z.number(), meta: z.object({ a: z.number() }) }) as Record<
        string,
        z.ZodTypeAny
      >,
    );
    expect(obj.parse({ width: 720, meta: { a: 1 } })).toEqual({ width: 720, meta: { a: 1 } });
  });

  it("does NOT corrupt a string field that happens to hold a number-like value", () => {
    const obj = z.object(
      coerceInputSchema({ code: z.string() }) as Record<string, z.ZodTypeAny>,
    );
    expect(obj.parse({ code: "720" })).toEqual({ code: "720" });
  });

  it("keeps optional fields optional (undefined still valid)", () => {
    const obj = z.object(
      coerceInputSchema({ n: z.number().optional() }) as Record<string, z.ZodTypeAny>,
    );
    expect(obj.parse({})).toEqual({});
    expect(obj.parse({ n: "5" })).toEqual({ n: 5 });
    // and the emitted JSON schema must not list it as required
    const json = zodToJsonSchema(obj) as { required?: string[] };
    expect(json.required ?? []).not.toContain("n");
  });

  it("preserves a ZodObject's .strict() modifier", () => {
    const strictObj = z.object({ a: z.number() }).strict();
    const coerced = coerceInputSchema(strictObj) as z.AnyZodObject;
    // still coerces
    expect(coerced.parse({ a: "3" })).toEqual({ a: 3 });
    // still rejects unknown keys
    expect(() => coerced.parse({ a: 1, extra: true })).toThrow();
  });

  it("leaves the emitted JSON schema's properties intact (no blanking)", () => {
    const shape = { width: z.number(), name: z.string(), meta: z.object({ a: z.number() }) };
    const obj = z.object(coerceInputSchema(shape) as Record<string, z.ZodTypeAny>);
    const json = zodToJsonSchema(obj) as { properties?: Record<string, unknown> };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual(["meta", "name", "width"]);
  });
});

describe("installArgCoercion (real MCP SDK round-trip)", () => {
  it("tools/list still emits properties AND tools/call receives coerced args", async () => {
    const server = new McpServer({ name: "coerce-test", version: "0.0.0" });
    installArgCoercion(server);

    let received: Record<string, unknown> | null = null;
    server.registerTool(
      "demo",
      {
        description: "demo tool",
        inputSchema: {
          width: z.number(),
          meta: z.object({ a: z.number() }),
          tags: z.array(z.string()),
          name: z.string(),
        },
      },
      async (params: Record<string, unknown>) => {
        received = params;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    );

    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "c", version: "0.0.0" });
    await client.connect(clientT);

    try {
      const list = await client.listTools();
      const demo = list.tools.find((t) => t.name === "demo");
      expect(demo).toBeDefined();
      // The JSON schema must still advertise the params (not blanked).
      const props = (demo!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
      expect(Object.keys(props).sort()).toEqual(["meta", "name", "tags", "width"]);

      // Client sends everything as stringified JSON (the failure mode).
      await client.callTool({
        name: "demo",
        arguments: { width: "720", meta: '{"a":1}', tags: '["x"]', name: "hello" },
      });
      expect(received).toEqual({ width: 720, meta: { a: 1 }, tags: ["x"], name: "hello" });
    } finally {
      await client.close();
    }
  });
});
