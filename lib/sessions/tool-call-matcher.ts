/**
 * Pure matcher: which cached chat tool-call part does a job's progress
 * belong to? Matching is exact on tool identity (canonical McpToolId) and
 * on the ARGS SUBSET: every key the tool-call part's args carry must
 * deep-equal the same key in the job's toolArgs. (Zod defaults only ADD
 * keys on the tool side, so part.args ⊆ toolArgs is the right direction.)
 * Ties break OLDEST-first — MCP tool execution is sequential, so the
 * oldest unresolved call is the one actually executing. (The old
 * newest-first name fallback attributed obama's tracking job to the
 * jobs-speech row — see .superpowers/qa/2026-07-04-chatui-verify.md.)
 *
 * A MERGED tool (`libi.show`, `libi.keyframe`, … — lib/agents/merged-tools.ts) is
 * several former tools under one name, so the name alone no longer tells two calls
 * apart: a call whose args name another action/target is never the match, and the
 * name-only degrade below does not apply to that difference. (A part whose args have
 * not streamed in yet carries no action and stays a candidate, as before.)
 */
import { parseMcpToolId, type McpToolId } from "@/lib/agents/mcp-tool-id";
import { mergedToolAction } from "@/lib/agents/merged-tools";

export interface ToolCallCandidate {
  toolCallId: string;
  toolId: McpToolId | null;
  args: unknown;
  /** Announce order — lower is older. */
  order: number;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    if (typeof b !== "object" || Array.isArray(b)) return false;
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}

/** True when every key present in `partArgs` deep-equals the same key in
 *  `toolArgs`. Non-object partArgs (null/undefined/{}) trivially match. */
export function argsSubsetMatches(partArgs: unknown, toolArgs: unknown): boolean {
  if (partArgs === null || partArgs === undefined) return true;
  if (typeof partArgs !== "object" || Array.isArray(partArgs)) return true;
  if (toolArgs === null || typeof toolArgs !== "object") {
    return Object.keys(partArgs as object).length === 0;
  }
  return Object.entries(partArgs as Record<string, unknown>).every(([k, v]) =>
    deepEqual(v, (toolArgs as Record<string, unknown>)[k]),
  );
}

/** True when `c` is a call of a merged tool whose action/target differs from the one `toolArgs` carries. */
function otherAction(c: ToolCallCandidate, toolArgs: unknown): boolean {
  if (toolArgs === undefined || c.toolId === null) return false;
  const toolName = parseMcpToolId(c.toolId)?.toolName;
  if (!toolName) return false;
  const wanted = mergedToolAction(toolName, toolArgs);
  const had = mergedToolAction(toolName, c.args);
  return wanted !== null && had !== null && wanted !== had;
}

export function matchToolCall(
  candidates: ToolCallCandidate[],
  hint: { toolIds: McpToolId[]; toolArgs?: unknown },
): string | null {
  const idSet = new Set(hint.toolIds);
  const byName = candidates
    .filter((c) => c.toolId !== null && idSet.has(c.toolId) && !otherAction(c, hint.toolArgs))
    .sort((a, b) => a.order - b.order);
  if (byName.length === 0) return null;
  if (hint.toolArgs !== undefined) {
    const byArgs = byName.filter((c) => argsSubsetMatches(c.args, hint.toolArgs));
    if (byArgs.length > 0) return byArgs[0].toolCallId;
    // Args filter emptied the list — degrade to name-only (still oldest).
  }
  return byName[0].toolCallId;
}
