/**
 * What `registerActionTool` (action-tool.ts) knows about each merged tool once
 * it is registered: the discriminator and the declared actions. Pure data (no
 * zod, no SDK) so `mcp/analytics.ts` can read it without loading the tools.
 *
 * Process-global and idempotent: one MCP server is built per session
 * (mcp/http/session.ts) and each registers the same entries.
 */
import { mergedToolAction } from "@/lib/agents/merged-tools";

export interface MergedToolInfo {
  discriminator: string;
  actions: readonly string[];
}

const REGISTRY = new Map<string, MergedToolInfo>();

export function recordMergedTool(name: string, info: MergedToolInfo): void {
  REGISTRY.set(name, info);
}

/** Every merged tool registered so far, by name. */
export function registeredMergedTools(): ReadonlyMap<string, MergedToolInfo> {
  return REGISTRY;
}

/** The action a call carries, if it is one the tool declares; `"invalid"` for any other
 *  string (so a typo cannot widen an analytics param's cardinality); undefined when the
 *  tool is not merged or the call named no action. */
export function boundedActionOf(toolName: string, args: unknown): string | undefined {
  const action = mergedToolAction(toolName, args);
  if (action === null) return undefined;
  const info = REGISTRY.get(toolName);
  if (!info) return undefined;
  return info.actions.includes(action) ? action : "invalid";
}
