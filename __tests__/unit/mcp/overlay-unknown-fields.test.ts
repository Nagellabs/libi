/**
 * `libi.add_overlay` / `libi.update_overlay` refuse a field they don't have.
 *
 * Found live (skill-eval code-overlays 02, 2026-09-23): the agent called
 * `add_overlay({ kind: "code", drawFunction: "…" })`. `drawFunction` is the
 * STORED name of a code body (and a real field of tracked-code content), but
 * the tool's field is `body`. zod's default `strip` dropped the key, the
 * handler scaffolded its starter, and the call returned `success: true` — so
 * the agent spent two renders debugging a body it never wrote.
 *
 * The advertised JSON Schema already said `additionalProperties: false`; the
 * server now enforces it, and the refusal names the right field. Nothing
 * reaches the handler, so nothing is written.
 *
 * Asserted through a REAL MCP client against a REAL server: the registration
 * path rebuilds every schema (`installArgCoercion`), and that rebuild is where
 * strictness or the custom message could silently be lost.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const { addOverlay, updateOverlay } = vi.hoisted(() => {
  type Handler = (params: Record<string, unknown>) => Promise<{ success: boolean; data: unknown }>;
  const ok: Handler = async () => ({ success: true, data: { overlayId: "code-x" } });
  return { addOverlay: vi.fn<Handler>(ok), updateOverlay: vi.fn<Handler>(ok) };
});
vi.mock("@/mcp/tools/overlay-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/mcp/tools/overlay-tools")>()),
  addOverlay,
  updateOverlay,
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

async function call(name: string, args: Record<string, unknown>) {
  const res = (await withClient((c) => c.callTool({ name, arguments: args }))) as {
    isError?: boolean;
    content: { type: string; text: string }[];
  };
  return { isError: res.isError === true, text: res.content.map((c) => c.text).join("\n") };
}

const CODE_ADD = {
  pieceId: "p1",
  kind: "code",
  displayName: "probe",
  startTime: 0,
  duration: 3,
  rect: { x: 0, y: 0, width: 1920, height: 1080 },
};
const BODY = "const { ctx } = context; ctx.fillRect(0, 0, 10, 10);";

beforeEach(() => {
  addOverlay.mockClear();
  updateOverlay.mockClear();
});

describe("libi.add_overlay refuses unknown fields", () => {
  it("refuses drawFunction on a code overlay, names `body`, and never reaches the handler", async () => {
    const r = await call("libi.add_overlay", { ...CODE_ADD, drawFunction: BODY });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("drawFunction");
    expect(r.text).toContain("`body`");
    expect(r.text).toMatch(/nothing was created/i);
    expect(addOverlay).not.toHaveBeenCalled();
  });

  it("refuses sceneFunction on a three overlay and names `body`", async () => {
    const r = await call("libi.add_overlay", { ...CODE_ADD, kind: "three", sceneFunction: BODY });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("sceneFunction");
    expect(r.text).toContain("`body`");
    expect(addOverlay).not.toHaveBeenCalled();
  });

  it("refuses other code-ish names (code, source, script) and names `body`", async () => {
    for (const key of ["code", "source", "script"]) {
      const r = await call("libi.add_overlay", { ...CODE_ADD, [key]: BODY });
      expect(r.isError, key).toBe(true);
      expect(r.text, key).toContain("`body`");
    }
    expect(addOverlay).not.toHaveBeenCalled();
  });

  it("refuses a misspelled field and suggests the real one", async () => {
    const r = await call("libi.add_overlay", { ...CODE_ADD, bdoy: BODY });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("bdoy");
    expect(r.text).toContain("`body`");
    expect(addOverlay).not.toHaveBeenCalled();
  });

  it("points name / label (both sent live) at `displayName`", async () => {
    for (const key of ["name", "label"]) {
      const args: Record<string, unknown> = { ...CODE_ADD, body: BODY, [key]: "probe" };
      delete args.displayName;
      const r = await call("libi.add_overlay", args);
      expect(r.isError, key).toBe(true);
      expect(r.text, key).toContain("`displayName`");
    }
    expect(addOverlay).not.toHaveBeenCalled();
  });

  it("points an update-only field at update_overlay", async () => {
    const r = await call("libi.add_overlay", { ...CODE_ADD, body: BODY, place3d: true });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("place3d");
    expect(r.text).toContain("libi.update_overlay");
    expect(addOverlay).not.toHaveBeenCalled();
  });

  it("tells an agent that sends overlayId that add_overlay assigns it, not to set it later (Task 15 re-review cosmetic)", async () => {
    const r = await call("libi.add_overlay", { ...CODE_ADD, body: BODY, overlayId: "mine" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("overlayId");
    expect(r.text).toMatch(/add_overlay assigns/);
    expect(r.text).not.toMatch(/set it with libi\.update_overlay/);
    expect(addOverlay).not.toHaveBeenCalled();
  });

  it("never takes the update-only branch for an Object.prototype name", async () => {
    const r = await call("libi.add_overlay", { ...CODE_ADD, body: BODY, constructor: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("constructor");
    expect(r.text).not.toContain("libi.update_overlay");
    expect(addOverlay).not.toHaveBeenCalled();
  });

  it("still accepts a well-formed code overlay (positive control)", async () => {
    const r = await call("libi.add_overlay", { ...CODE_ADD, body: BODY });
    expect(r.isError).toBe(false);
    expect(addOverlay).toHaveBeenCalledTimes(1);
    expect(addOverlay.mock.calls[0]![0]).toMatchObject({ kind: "code", body: BODY });
  });

  it("still coerces a stringified rect (the coercion layer survived the rebuild)", async () => {
    const r = await call("libi.add_overlay", {
      ...CODE_ADD,
      body: BODY,
      rect: JSON.stringify(CODE_ADD.rect),
    });
    expect(r.isError).toBe(false);
    expect(addOverlay.mock.calls[0]![0]).toMatchObject({ rect: CODE_ADD.rect });
  });
});

describe("libi.update_overlay refuses unknown fields", () => {
  it("refuses a code body under any name and points at codeFilePath", async () => {
    for (const key of ["body", "drawFunction", "sceneFunction"]) {
      const r = await call("libi.update_overlay", { pieceId: "p1", overlayId: "code-x", [key]: BODY });
      expect(r.isError, key).toBe(true);
      expect(r.text, key).toContain(key);
      expect(r.text, key).toContain("codeFilePath");
      expect(r.text, key).toMatch(/nothing was changed/i);
    }
    expect(updateOverlay).not.toHaveBeenCalled();
  });

  it("refuses a misspelled field and suggests the real one", async () => {
    const r = await call("libi.update_overlay", { pieceId: "p1", overlayId: "code-x", opacityy: 0.5 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("`opacity`");
    expect(updateOverlay).not.toHaveBeenCalled();
  });

  it("still accepts a well-formed update (positive control)", async () => {
    const r = await call("libi.update_overlay", { pieceId: "p1", overlayId: "code-x", opacity: 0.5 });
    expect(r.isError).toBe(false);
    expect(updateOverlay).toHaveBeenCalledTimes(1);
  });

  it("accepts fileId through the strict registered schema and hands it to the handler (templates fill a media slot this way)", async () => {
    const r = await call("libi.update_overlay", { pieceId: "p1", overlayId: "img-x", fileId: "f1" });
    expect(r.isError).toBe(false);
    expect(updateOverlay).toHaveBeenCalledTimes(1);
    expect(updateOverlay.mock.calls[0]![0]).toMatchObject({ pieceId: "p1", overlayId: "img-x", fileId: "f1" });
  });

  it("refuses a mis-cased fileID and suggests `fileId`", async () => {
    const r = await call("libi.update_overlay", { pieceId: "p1", overlayId: "img-x", fileID: "f1" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("`fileId`");
    expect(updateOverlay).not.toHaveBeenCalled();
  });
});

describe("the common guesses are named (follow-ups T10, SB-26a)", () => {
  it("add_overlay: `text` → content, top-level width/height → rect", async () => {
    const r = await call("libi.add_overlay", { pieceId: "p1", kind: "text", text: "Hi", width: 100, height: 50, startTime: 0, duration: 1 });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/`content`/);
    // The hint shows the shape: `rect: { x, y, width, height }`.
    expect(r.text).toMatch(/`rect: \{/);
    expect(r.text).toContain("`text` — a text overlay's words go in `content`.");
    expect(r.text).toContain("`width` — size goes in `rect: { x, y, width, height }`.");
    expect(r.text).toContain("`height` — size goes in `rect: { x, y, width, height }`.");
    expect(addOverlay).not.toHaveBeenCalled();
  });

  it("update_overlay: `text` → content, top-level width → rect", async () => {
    const r = await call("libi.update_overlay", { pieceId: "p1", overlayId: "text-x", text: "Hi", width: 100 });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("`text` — a text overlay's words go in `content`.");
    expect(r.text).toContain("`width` — size goes in `rect: { x, y, width, height }`.");
    expect(r.text).toMatch(/nothing was changed/i);
    expect(updateOverlay).not.toHaveBeenCalled();
  });
});

describe("tools/list is intact", () => {
  it("still lists every tool, and both overlay tools advertise additionalProperties:false", async () => {
    const { tools } = await withClient((c) => c.listTools());
    const names = tools.map((t) => t.name);
    // Canary: a zod v4 schema would empty this list silently.
    expect(names.length).toBeGreaterThan(50);
    for (const name of ["libi.add_overlay", "libi.update_overlay"]) {
      const tool = tools.find((t) => t.name === name);
      expect(tool, name).toBeTruthy();
      expect(tool!.inputSchema.additionalProperties, name).toBe(false);
      expect(Object.keys(tool!.inputSchema.properties ?? {}), name).toContain("pieceId");
    }
    const add = tools.find((t) => t.name === "libi.add_overlay")!;
    expect(Object.keys(add.inputSchema.properties ?? {})).toContain("body");
  });
});
