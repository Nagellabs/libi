/**
 * `libi.create_piece` refuses a field it doesn't have (follow-ups T10, CH-2).
 *
 * zod's default `strip` dropped an unknown key silently: `create_piece({ width,
 * height })` made a 1080×1920 piece and reported success, the size nowhere.
 * The tool now refuses, and for the canvas-size guesses points at
 * `libi.update_composition_dimensions`. Nothing reaches the handler.
 *
 * Asserted through a REAL MCP client against a REAL server: the registration
 * path rebuilds every schema (`installArgCoercion`), and that rebuild is where
 * strictness or the custom message could silently be lost.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { createPiece } = vi.hoisted(() => {
  type Handler = (params: Record<string, unknown>) => Promise<{ success: boolean; data: unknown }>;
  return { createPiece: vi.fn<Handler>(async () => ({ success: false, data: null })) };
});
vi.mock("@/mcp/tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools")>()),
  createPiece,
}));

import { createLibiMcpServer } from "@/mcp/server";

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const server = createLibiMcpServer();
  const client = new Client({ name: "test", version: "0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    return await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

async function call(args: Record<string, unknown>) {
  const res = (await withClient((c) => c.callTool({ name: "libi.create_piece", arguments: args }))) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: res.isError === true, text: res.content.map((c) => c.text).join("\n") };
}

beforeEach(() => createPiece.mockClear());

describe("libi.create_piece refuses unknown fields", () => {
  it("width/height → a pointer to update_composition_dimensions, and nothing is created", async () => {
    const r = await call({ name: "x", width: 1080, height: 1080 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/update_composition_dimensions/);
    expect(r.text).toContain("`width`");
    expect(r.text).toContain("`height`");
    expect(r.text).toMatch(/nothing was created/i);
    expect(createPiece).not.toHaveBeenCalled();
  });

  it("aspect / dimensions get the same pointer", async () => {
    for (const key of ["aspect", "dimensions"]) {
      const r = await call({ name: "x", [key]: "9:16" });
      expect(r.isError, key).toBe(true);
      expect(r.text, key).toMatch(/update_composition_dimensions/);
    }
    expect(createPiece).not.toHaveBeenCalled();
  });

  // Fix round 1 (review I1): update_composition_dimensions takes no fps and would drop it silently.
  it("fps says plainly that no tool sets a frame rate, and never points at update_composition_dimensions", async () => {
    const r = await call({ name: "x", fps: 60 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(
      "`fps` — a piece's frame rate can't be set: a new piece is 30 fps and no libi tool changes it. Create the piece without `fps`, and tell the user it stays at 30 fps.",
    );
    expect(r.text).not.toMatch(/update_composition_dimensions/);
    expect(createPiece).not.toHaveBeenCalled();
  });

  it("any other unknown key gets a did-you-mean", async () => {
    const r = await call({ nmae: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("did you mean `name`?");
    expect(createPiece).not.toHaveBeenCalled();
  });

  it("a valid call still works and reaches the handler unchanged", async () => {
    await call({ name: "x" });
    expect(createPiece).toHaveBeenCalledWith({ name: "x" });
    await call({ name: "y", description: "d" });
    expect(createPiece).toHaveBeenLastCalledWith({ name: "y", description: "d" });
    await call({});
    expect(createPiece).toHaveBeenLastCalledWith({});
  });

  it("tools/list still advertises it with additionalProperties:false", async () => {
    const { tools } = await withClient((c) => c.listTools());
    const t = tools.find((x) => x.name === "libi.create_piece")!;
    expect((t.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false);
    expect(Object.keys(t.inputSchema.properties ?? {}).sort()).toEqual(["description", "name"]);
    expect(tools.length).toBeGreaterThan(150); // a zod/v4 slip empties tools/list silently
  });
});
