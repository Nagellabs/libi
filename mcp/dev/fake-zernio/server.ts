import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { mcpLogger as logger } from "@/lib/logger";
import { LISTED_TOOL_DEFS } from "./schemas";
import { HANDLERS, type ToolAnswer, type ToolContext } from "./tools";
import { CURATED_TOOLS, pythonRepr, unknownToolText, validationErrorText } from "./live-surface";
import { recordCall } from "./recorder";
import type { FakeState, Row } from "./state";

/**
 * The fake Zernio MCP server — a FAITHFUL LIAR, not a permissive stub.
 *
 * Four live behaviours it reproduces, each of which hid a defect once:
 *
 *  1. **`tools/list` advertises only the CURATED names.** The full-shaped REST
 *     tools libi actually uses (`posts_create_post`, `accounts_list_accounts`,
 *     …) are NOT listed and are reachable only by exact name through
 *     `call_tool`. A direct call to one is refused, exactly as live. A fake
 *     that listed them made a resolver preferring the listed name
 *     indistinguishable from one dispatching the right one — which is how that
 *     defect stayed green for two tasks.
 *  2. **Arguments are validated against the RECORDED `inputSchema`s**, all
 *     `additionalProperties: false`. `headers` — the idempotency slot that
 *     does not exist — and a camelCase write body both fail here, with the
 *     server's own pydantic text.
 *  3. **`Unknown tool: '<name>'`** for a name it does not serve. The
 *     resolver's single recovery attempt keys on exactly this string.
 *  4. **The `{ result: "<Python repr>" }` envelope.** Never JSON. The curated
 *     convenience tools go further and send PROSE inside `result`, which
 *     `parseZernioPayload` refuses — the tripwire that catches an op resolving
 *     to a lossy tool.
 *
 * It is served by the low-level `Server` rather than `McpServer` for reasons
 * 1–3: `McpServer` lists everything it registers, and its own zod validation
 * would answer a JSON-RPC error instead of the provider's text.
 */
export function createFakeZernioMcpServer(state: FakeState, baseUrl: string): Server {
  const ctx: ToolContext = { state, baseUrl };

  const server = new Server(
    { name: "zernio", version: "0.1.0-fake" },
    {
      capabilities: { tools: {} },
      instructions:
        "Zernio API server for scheduling social media posts (TEST MODE FAKE — in-memory, zero cost).\n\n" +
        "Tools are prefixed by resource: accounts_*, posts_*, analytics_*, media_*, docs_*.\n" +
        "Only a curated subset is listed; the full REST surface is reachable by exact name through `call_tool`.\n\n" +
        "MULTI-ACCOUNT WORKFLOW: when more than one account shares a platform you MUST pass `account_id`. " +
        "Call `accounts_list` first. A write that omits it returns an error listing the candidates — read it and retry. " +
        "Never guess.",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: LISTED_TOOL_DEFS }));

  server.setRequestHandler(CallToolRequestSchema, async (req): Promise<CallToolResult> => {
    const outerName = req.params.name;
    const outerArgs = (req.params.arguments ?? {}) as Row;
    if (outerName === "call_tool") {
      const invalid = validationErrorText("call_tool", outerArgs);
      if (invalid) return refuse("call_tool", outerArgs, "direct", invalid);
      const inner = String(outerArgs.name ?? "");
      const innerArgs = (outerArgs.arguments ?? {}) as Row;
      return dispatch(inner, innerArgs, "call_tool");
    }
    // Live, a name `tools/list` does not advertise cannot be called directly:
    // only the curated names are dispatchable without the `call_tool` hop.
    if (!CURATED_TOOLS.includes(outerName)) {
      return refuse(outerName, outerArgs, "direct", unknownToolText(outerName));
    }
    return dispatch(outerName, outerArgs, "direct");
  });

  function refuse(tool: string, input: Row, via: "direct" | "call_tool", text: string): CallToolResult {
    recordCall({ tool, via, input, rejected: true, ...idsFrom(tool, input) });
    logger.debug({ tag: "fake-zernio", op: "call_refused", tool, via }, "fake zernio refused a call");
    return { isError: true, content: [{ type: "text", text }] };
  }

  function dispatch(name: string, args: Row, via: "direct" | "call_tool"): CallToolResult {
    const handler = HANDLERS[name];
    if (!handler) return refuse(name, args, via, unknownToolText(name));
    const invalid = validationErrorText(name, args);
    if (invalid) return refuse(name, args, via, invalid);

    const answer = handler(args, ctx);
    const ids = idsFrom(name, args, answer);
    recordCall({ tool: name, via, input: args, ...ids, ...(answer.kind === "error" ? { rejected: true as const } : {}) });
    logger.debug({ tag: "fake-zernio", op: "call", tool: name, via, kind: answer.kind }, "fake zernio served a call");
    return toResult(answer);
  }

  logger.info({ tag: "fake-zernio", op: "server_created", listed: LISTED_TOOL_DEFS.length }, "fake zernio MCP server created");
  return server;
}

/**
 * The fastmcp envelope. `structuredContent` is `{ result: "<string>" }` and
 * the text block carries the same thing serialized — which is what the live
 * server sends and what `parseZernioPayload` is written against.
 */
function toResult(answer: ToolAnswer): CallToolResult {
  if (answer.kind === "error") return { isError: true, content: [{ type: "text", text: answer.text }] };
  const inner = answer.kind === "prose" ? answer.text : pythonRepr(answer.value);
  return { content: [{ type: "text", text: JSON.stringify({ result: inner }) }], structuredContent: { result: inner } };
}

/** The two ids the skill-eval assertions select on, when the call carries them. */
function idsFrom(tool: string, args: Row, answer?: ToolAnswer): { post_id?: string; request_id?: string } {
  const out: { post_id?: string; request_id?: string } = {};
  if (typeof args.post_id === "string") out.post_id = args.post_id;
  const metadata = args.metadata as { libi?: { requestId?: unknown } } | undefined;
  if (typeof metadata?.libi?.requestId === "string") out.request_id = metadata.libi.requestId;
  if (answer?.kind === "value") {
    const post = (answer.value as { post?: { _id?: unknown } } | undefined)?.post;
    if (typeof post?._id === "string") out.post_id = post._id;
  }
  void tool;
  return out;
}
