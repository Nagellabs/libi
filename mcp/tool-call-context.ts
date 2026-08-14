/**
 * Per-tool-call context for the MCP stdio child.
 *
 * The MCP request carries no ACP toolCallId (the SDK's progressToken is a
 * per-request counter, NOT the toolCallId), so exact job↔chat-row
 * correlation is impossible from IDs alone. Instead, the registerTool
 * wrapper records WHICH tool is executing with WHICH args; `jobs-client`
 * ships that as a `toolHint` on POST /api/jobs and the server matches it
 * against the cached tool-call parts (tool identity + args subset).
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolCallContext {
  toolName: string;
  args: unknown;
}

const als = new AsyncLocalStorage<ToolCallContext>();

export function runWithToolCallContext<T>(
  toolName: string,
  args: unknown,
  fn: () => Promise<T>,
): Promise<T> {
  return als.run({ toolName, args }, fn);
}

export function getCurrentToolCall(): ToolCallContext | null {
  return als.getStore() ?? null;
}

type RegisterFn = (...args: unknown[]) => unknown;

/** Same wrapper shape as `wrapRegisterToolWithTracking` (mcp/analytics.ts):
 *  args[0] is the tool name, the last arg is the handler whose FIRST arg is
 *  the parsed tool params. */
export function wrapRegisterToolWithContext(register: RegisterFn): RegisterFn {
  return (...args: unknown[]) => {
    const name = args[0] as string;
    const handler = args[args.length - 1] as (...h: unknown[]) => unknown;
    const wrappedHandler = (...hargs: unknown[]) =>
      runWithToolCallContext(name, hargs[0], async () => handler(...hargs));
    const newArgs = [...args];
    newArgs[newArgs.length - 1] = wrappedHandler;
    return register(...newArgs);
  };
}
