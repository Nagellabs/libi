import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  McpError,
  ErrorCode,
  type Progress,
} from "@modelcontextprotocol/sdk/types.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { createTestDb } from "@/__tests__/helpers/test-db";
import { createAggregateSession, unwrapProxiedError } from "@/mcp/http/session";
import { renderAgentInstructions } from "@/mcp/workspace";
import { LIBI_MCP_ENTRY_NAME } from "@/lib/mcp/agent-surface";
import { DEFAULT_INDEX_BUDGET_BYTES } from "@/mcp/manual-sections";

async function connectClient(surface: "in-app" | "cli") {
  const session = await createAggregateSession({ surface, dialect: "claude", instructions: "HELLO-INSTRUCTIONS" });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await session.server.connect(serverT);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientT);
  return { client, session };
}

describe("createAggregateSession", () => {
  beforeEach(() => { createTestDb(); });

  it("advertises the instructions and libi's tools — and only libi's", async () => {
    const { client } = await connectClient("cli");
    expect(client.getInstructions()).toBe("HELLO-INSTRUCTIONS");
    const names = (await client.listTools()).tools.map((x) => x.name);
    expect(names).toContain("libi.list_pieces");
    expect(names.every((n) => n.startsWith("libi."))).toBe(true);
    expect(names).not.toContain("libi.show_in_chat");
  });

  it("in-app surface lists libi.show_in_chat; cli does not", async () => {
    const inApp = await connectClient("in-app");
    expect((await inApp.client.listTools()).tools.map((x) => x.name)).toContain("libi.show_in_chat");
  });

  /**
   * Backstop. libi's ACP entry now carries the SAME name `libi connect`
   * writes (`LIBI_MCP_ENTRY_NAME`), so it REPLACES the config registration and
   * an in-app agent should never hold a `cli` libi session at all. This branch
   * is therefore a TRIPWIRE for that replacement failing — a codex-acp that
   * stopped honouring `CODEX_ACP_DISABLE_MCP_FILTER_ENV`, or a Claude CLI that
   * stopped letting `--mcp-config` win. It must still say something the model
   * can act on: the observed failure was a model concluding the tool does not
   * exist and dropping the request silently.
   */
  it("refuses libi.show_in_chat on a cli session and says what to do instead", async () => {
    const { client } = await connectClient("cli");
    const res = await client.callTool({ name: "libi.show_in_chat", arguments: {} });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain("libi.show_in_chat");
    // Names the registration this session actually is …
    expect(text).toContain(`\\"${LIBI_MCP_ENTRY_NAME}\\" registration`);
    // … covers the terminal reading …
    expect(text).toContain("libi.show_asset");
    // … and the in-app one, which is now a fault to report rather than a
    // sibling entry to retry on.
    expect(text).toContain("failed to replace");
  });

  it("still gives a plain unknown-tool answer for a name that is on neither surface", async () => {
    const { client } = await connectClient("cli");
    const res = await client.callTool({ name: "libi.not_a_tool", arguments: {} });
    expect(res.isError).toBe(true);
    const text = JSON.stringify(res.content);
    expect(text).toContain("libi.not_a_tool");
    expect(text).not.toContain("failed to replace");
  });

  it("does not hijack an in-app session's unknown-tool answer", async () => {
    const { client } = await connectClient("in-app");
    const res = await client.callTool({ name: "libi.show_in_chat", arguments: {} });
    // Registered here — it fails on its arguments, not on routing.
    expect(JSON.stringify(res.content)).not.toContain("failed to replace");
  });

  // `libi.read_manual` is SECTIONED: the full manual is ~87 KB,
  // which Claude Code spools to a file instead of reading. No argument returns
  // the index + the pre-first-edit essentials; a key returns one section.
  const manualText = (res: unknown) =>
    ((res as { content?: Array<{ type: string; text?: string }> }).content ?? [])[0]?.text ?? "";

  it("exposes libi.read_manual and it returns the section index, not the whole manual", async () => {
    const { client } = await connectClient("cli");
    expect((await client.listTools()).tools.map((x) => x.name)).toContain("libi.read_manual");
    const res = await client.callTool({ name: "libi.read_manual", arguments: {} });
    const text = manualText(res);
    expect(res.isError ?? false).toBe(false);
    // The index lists `mcp-tools` without inlining its 25 KB of body.
    expect(text).toContain("`mcp-tools`");
    expect(text).toContain('libi.read_manual({ section: "<key>" })');
    // …and it carries the workflow material needed before a first edit.
    expect(text).toContain("## Workflow");
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(DEFAULT_INDEX_BUDGET_BYTES);
  });

  it("returns just the asked-for section, matching case- and punctuation-insensitively", async () => {
    const { client } = await connectClient("cli");
    const res = await client.callTool({
      name: "libi.read_manual",
      arguments: { section: "MCP tools" },
    });
    const text = manualText(res);
    expect(res.isError ?? false).toBe(false);
    expect(text.startsWith("## MCP Tools")).toBe(true);
    expect(text).not.toContain("## Canvas Coordinate System");
  });

  it("section 'all' still returns the whole manual", async () => {
    const { client } = await connectClient("cli");
    const res = await client.callTool({ name: "libi.read_manual", arguments: { section: "all" } });
    const text = manualText(res);
    expect(text).toBe(renderAgentInstructions("claude"));
    expect(text).toContain("## MCP Tools");
    expect(text).toContain("## Canvas Coordinate System");
  });

  it("an unknown section is an error listing the valid keys, never an empty success", async () => {
    const { client } = await connectClient("cli");
    const res = await client.callTool({
      name: "libi.read_manual",
      arguments: { section: "does-not-exist" },
    });
    expect(res.isError).toBe(true);
    const text = manualText(res);
    expect(text).toContain("does-not-exist");
    expect(text).toContain("mcp-tools");
  });

  it("routes a libi tool to libi's own server", async () => {
    const { client } = await connectClient("cli");
    const res = await client.callTool({ name: "libi.list_pieces", arguments: {} });
    expect(res.isError ?? false).toBe(false);
  });

  it("answers an unknown tool with isError, never a thrown JSON-RPC error", async () => {
    const { client } = await connectClient("cli");
    const res = await client.callTool({ name: "generate_image", arguments: { prompt: "a cat" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("generate_image");
  });

  /**
   * The proxy used to call the in-process libi server with NO
   * `RequestOptions`, so the inner hop inherited the SDK's 60 s default and
   * forwarded neither the progress token nor the abort signal. QA measured it:
   * `libi.sleep({ seconds: 90 })` under a 300 s client timeout failed at
   * exactly 60.0 s, in 6 of 6 long calls, while the work completed
   * server-side. These three pin the options that fix it.
   */
  describe("long-running tool calls", () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("never leaves the inner hop on the SDK's 60 s default, and forwards the abort signal", async () => {
      const seen: RequestOptions[] = [];
      const spy = vi.spyOn(Client.prototype, "callTool");
      spy.mockImplementation(async function (this: Client, ...callArgs: unknown[]) {
        seen.push((callArgs[2] ?? {}) as RequestOptions);
        return { content: [] };
      } as never);
      const { client } = await connectClient("cli");
      // Drive the outer hop with the low-level `request`, not `callTool` —
      // both clients share the prototype the spy is on, and only the inner
      // hop's options are the subject here.
      await client.request(
        { method: "tools/call", params: { name: "libi.list_pieces", arguments: {} } },
        CallToolResultSchema,
      );
      expect(seen).toHaveLength(1);
      const opts = seen[0];
      // 60_000 is DEFAULT_REQUEST_TIMEOUT_MSEC — the number that killed every
      // call. Anything at or below it reintroduces the defect.
      expect(opts.timeout).toBeGreaterThan(60_000);
      expect(opts.resetTimeoutOnProgress).toBe(true);
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it("forwards notifications/progress to the outer client under the outer token", async () => {
      const { client } = await connectClient("cli");
      const ticks: Progress[] = [];
      const res = await client.callTool(
        { name: "libi.sleep", arguments: { seconds: 1, reason: "d1 proof" } },
        undefined,
        { onprogress: (p) => ticks.push(p) },
      );
      expect(res.isError ?? false).toBe(false);
      // libi.sleep ticks once per chunk; a 1 s sleep is exactly one chunk.
      expect(ticks.length).toBeGreaterThanOrEqual(1);
      expect(ticks[0].total).toBe(1000);
      expect(String(ticks[0].message)).toContain("d1 proof");
    }, 15_000);

    it("does not double the MCP error prefix when an inner error crosses the hop", () => {
      const doubled = unwrapProxiedError(
        new McpError(ErrorCode.RequestTimeout, "Request timed out"),
      ) as McpError;
      // The inner McpError's own message already reads
      // "MCP error -32001: Request timed out"; re-wrapping it verbatim is what
      // produced the doubled prefix QA saw. One layer, not two.
      expect(doubled.message).toBe("MCP error -32001: Request timed out");
      expect(doubled.code).toBe(ErrorCode.RequestTimeout);
      // Anything that is not an McpError is passed through untouched.
      const plain = new Error("boom");
      expect(unwrapProxiedError(plain)).toBe(plain);
    });
  });

  it("close() releases both in-memory sides", async () => {
    const { client, session } = await connectClient("cli");
    await client.listTools();
    await session.close();
    await expect(client.listTools()).rejects.toThrow();
  });
});
