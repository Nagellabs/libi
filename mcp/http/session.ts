import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  CallToolResultSchema,
  McpError,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  isInAppOnlyTool,
  LIBI_MCP_ENTRY_NAME,
  type AgentSurface,
} from "@/lib/mcp/agent-surface";
import { mcpLogger as logger } from "@/lib/logger";
import { createLibiMcpServer } from "@/mcp/server";
import { LIBI_SKILL_VERSION } from "@/mcp/version";
import { buildToolTable, type ToolTable } from "./tool-table";

/** Source key for libi's own tools in the routing table. */
const LIBI_SOURCE = "libi";

/**
 * Backstop timeout for the in-process hop, NOT a tool deadline.
 *
 * The MCP SDK applies `DEFAULT_REQUEST_TIMEOUT_MSEC` (60 s) to any request
 * made without `RequestOptions`, and this proxy used to make exactly that
 * call. So every libi tool died at 60.0 s no matter what the AGENT's timeout
 * was — the error was minted here, inside libi, which is why no client-side
 * `MCP_TIMEOUT` could raise it. `libi.export_video` (its own description says
 * "tens of seconds to minutes"), `libi.download_video`,
 * `libi.whisper_download_model`, `libi.install_tracking_engine` and
 * `libi.sleep` (schema allows 1800 s) all exceed 60 s routinely, and both
 * first-use extension installs — Chromium (~60-85 s) and uv+yt-dlp (~25 s
 * plus the download) — land on the far side of it on every fresh machine.
 *
 * The deadline belongs to the OUTER client: when it gives up it sends
 * `notifications/cancelled`, the SDK aborts `extra.signal`, and we forward
 * that signal to the inner hop (which is how `libi.sleep` returns partial and
 * how a job-backed tool stops waiting). This number therefore only has to be
 * larger than any legitimate call, so a wedged handler cannot pin an
 * in-process client entry forever. It is deliberately far past anything the
 * product does.
 */
const INNER_CALL_TIMEOUT_MS = 24 * 60 * 60_000;

/**
 * Re-throwing an `McpError` across a hop doubles its prefix: the class puts
 * `MCP error <code>: ` in `message`, the outer server forwards `message`
 * verbatim, and the outer client wraps it in an `McpError` again — QA saw
 * `MCP error -32001: MCP error -32001: Request timed out`. The doubling was
 * the tell that libi minted the error; strip our own layer so the client's
 * single prefix is the only one.
 */
export function unwrapProxiedError(err: unknown): unknown {
  if (err instanceof McpError) {
    return new McpError(err.code, err.message.replace(/^MCP error -?\d+: /, ""), err.data);
  }
  return err;
}

export interface AggregateSession {
  server: Server;
  close(): Promise<void>;
}

/**
 * What to say when a tool isn't on this session's surface.
 *
 * The interesting case is an IN-APP-ONLY tool asked for on a `cli` session.
 * The aggregator cannot see who is calling — a `cli` session is opened by a
 * terminal agent (legitimate: the user drives their own CLI outside the app),
 * and, if the in-app entry ever fails to replace the config one, by an in-app
 * agent that has only the headerless registration left.
 *
 * That second case is supposed to be IMPOSSIBLE now. libi's ACP entry carries
 * the SAME name `libi connect` writes (`LIBI_MCP_ENTRY_NAME`), so both adapters
 * replace the config entry with the session-scoped one rather than mounting
 * both. The reachable ways back here are a codex-acp that stopped honouring
 * `CODEX_ACP_DISABLE_MCP_FILTER_ENV` (it would drop libi's ACP entry again) or
 * a Claude CLI that stopped letting `--mcp-config` win over config. So this
 * branch is a TRIPWIRE, not routine: it logs, and it tells the model something
 * it can act on instead of a bare "unknown tool" — the failure the spike
 * observed was a model concluding "no tool called show_in_chat exists in my
 * tool registry" and dropping the request silently.
 *
 * Nothing is ADVERTISED to the cli surface by this: `tools/list` is unchanged,
 * so a terminal agent still never sees an in-app tool.
 */
function unknownToolText(name: string, surface: AgentSurface): string {
  if (surface !== "in-app" && isInAppOnlyTool(name)) {
    logger.warn(
      { tag: "mcp-http", op: "in_app_tool_on_cli_session", tool: name, entry: LIBI_MCP_ENTRY_NAME },
      "in-app-only tool called on a cli MCP session",
    );
    return (
      `"${name}" renders into the libi app's chat, and this MCP session is not ` +
      `attached to one — it is the "${LIBI_MCP_ENTRY_NAME}" registration a terminal ` +
      `agent uses. If you are in a terminal, this tool is not available to you: use ` +
      `libi.show_asset and give the user the printed URL. If you ARE running inside ` +
      `the libi app, then libi's in-app registration failed to replace the terminal ` +
      `one for this session — say so to the user, and use libi.show_asset meanwhile.`
    );
  }
  return `Unknown tool "${name}". Call tools/list — the set may have changed.`;
}

/**
 * One MCP session = one low-level `Server` whose tool surface is libi's own
 * `McpServer`, connected in-process over an InMemoryTransport so
 * `mcp/server.ts` is untouched and gets its per-session surface. `tools/call`
 * is routed by name; results are returned verbatim, `isError` included.
 *
 * libi's server and its in-memory client are PER SESSION because the surface
 * (`in-app` vs `cli`) decides which libi tools exist at all. Nothing else is
 * served: libi proxies no third-party MCP, so the table has exactly
 * one source and never changes for the life of the session.
 */
export async function createAggregateSession(opts: {
  surface: AgentSurface;
  dialect: "claude" | "codex";
  instructions: string;
}): Promise<AggregateSession> {
  // libi's own server, in-process.
  const libi = createLibiMcpServer({ surface: opts.surface, dialect: opts.dialect });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const libiClient = new Client({ name: "libi-aggregator/self", version: LIBI_SKILL_VERSION });
  // Both halves of the pair come up, or neither does. Session open is a path a
  // client can retry freely, and a throw from the SECOND connect used to leave
  // the first one wired to a server nobody held a reference to — one leaked
  // `McpServer` per failed open.
  try {
    await libi.connect(serverT);
    await libiClient.connect(clientT);
  } catch (err) {
    await libiClient.close().catch(() => {});
    await libi.close().catch(() => {});
    throw err;
  }

  let table: ToolTable | null = null;
  const rebuild = async (): Promise<ToolTable> => {
    const own = (await libiClient.listTools()).tools;
    table = buildToolTable(LIBI_SOURCE, own);
    return table;
  };

  const server = new Server(
    { name: "libi-video-studio", version: LIBI_SKILL_VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions: opts.instructions },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: (await rebuild()).tools }));

  server.setRequestHandler(CallToolRequestSchema, async (req, extra): Promise<CallToolResult> => {
    const { name, arguments: args } = req.params;
    const current = table ?? (await rebuild());
    const route = current.routes.get(name);
    if (!route) {
      return {
        isError: true,
        content: [{ type: "text", text: unknownToolText(name, opts.surface) }],
      };
    }
    // `_meta` is forwarded whole, not dropped. claude-agent-acp propagates the
    // ACP `sessionId` in it, and tools such as `libi.show_in_chat` and
    // `libi.restart_acp_session` resolve their session from
    // `extra._meta.sessionId` — over the in-memory hop there is no transport
    // session id to fall back to, so dropping `_meta` left them with "".
    const meta = req.params._meta;
    const progressToken = meta?.progressToken;
    try {
      return (await libiClient.callTool(
        {
          name: route.upstreamName,
          arguments: (args ?? {}) as Record<string, unknown>,
          ...(meta === undefined ? {} : { _meta: meta }),
        },
        CallToolResultSchema,
        {
          // The outer client's cancellation is the real deadline — see
          // INNER_CALL_TIMEOUT_MS.
          signal: extra.signal,
          timeout: INNER_CALL_TIMEOUT_MS,
          resetTimeoutOnProgress: true,
          // Requesting progress is what makes the SDK attach a progressToken
          // to the inner request at all, so libi's tools only emit
          // `notifications/progress` when the agent asked for them. Each inner
          // tick is re-sent under the OUTER token, on this request's stream.
          onprogress:
            progressToken === undefined
              ? undefined
              : (p) => {
                  void extra
                    .sendNotification({
                      method: "notifications/progress",
                      params: { ...p, progressToken },
                    })
                    .catch((err) =>
                      logger.debug({
                        err,
                        tag: "mcp-http",
                        op: "progress_forward_failed",
                        tool: name,
                      }),
                    );
                },
        },
      )) as CallToolResult;
    } catch (err) {
      throw unwrapProxiedError(err);
    }
  });

  return {
    server,
    close: async () => {
      await libiClient.close().catch(() => {});
      await libi.close().catch(() => {});
    },
  };
}
