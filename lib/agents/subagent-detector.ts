const SUBAGENT_TOOL_NAMES = new Set(["Task", "Agent"]);

/**
 * Detect a subagent (Task / Agent) dispatch.
 *
 * Two signals:
 *   1. Tool name is literally "Task" or "Agent" — what we see live, and
 *      what claude-agent-acp emits when no `description` is present.
 *   2. The args carry the subagent dispatch shape (`subagent_type`,
 *      `description`, `prompt`). claude-agent-acp uses the dispatch's
 *      `description` field as the tool `title` when available — so the
 *      title becomes "Describe video keyframes" instead of "Task" and
 *      the name-only check misses. We observed this in session
 *      9d544597 where a 1m+ sub-agent rendered as a tool-call with the
 *      JSON reply dumped inline.
 *
 * Pass `args` whenever you have them so the shape-based detection
 * kicks in. Calling without `args` keeps the old name-only behaviour.
 */
export function isSubagentDispatch(toolName: string, args?: unknown): boolean {
  if (SUBAGENT_TOOL_NAMES.has(toolName)) return true;
  if (args && typeof args === "object" && !Array.isArray(args)) {
    const a = args as Record<string, unknown>;
    if (typeof a.subagent_type === "string" && typeof a.description === "string") {
      return true;
    }
  }
  return false;
}

export interface ParsedDispatch {
  description: string;
  subagentType: string;
  model: string | null;
  background: boolean;
  prompt: string;
}

export function parseSubagentDispatch(args: unknown): ParsedDispatch | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  if (typeof a.description !== "string") return null;
  if (typeof a.subagent_type !== "string") return null;
  return {
    description: a.description,
    subagentType: a.subagent_type,
    model: typeof a.model === "string" ? a.model : null,
    background: a.run_in_background === true,
    prompt: typeof a.prompt === "string" ? a.prompt : "",
  };
}

export interface ParsedCompletion {
  status: "completed" | "failed" | "cancelled";
  result: string;
  usage: {
    totalTokens?: number;
    toolUses?: number;
    durationMs?: number;
  } | null;
}

export function parseSubagentCompletion(text: string): ParsedCompletion | null {
  if (!text.includes("<task-notification>")) return null;
  const statusMatch = text.match(/<status>([^<]+)<\/status>/);
  const resultMatch = text.match(/<result>([\s\S]*?)<\/result>/);
  const usageMatch = text.match(/<usage>([\s\S]*?)<\/usage>/);
  if (!statusMatch) return null;
  const rawStatus = statusMatch[1].trim();
  const status: ParsedCompletion["status"] =
    rawStatus === "completed" || rawStatus === "failed" || rawStatus === "cancelled"
      ? rawStatus
      : "failed";
  let usage: ParsedCompletion["usage"] = null;
  if (usageMatch) {
    const usageBlock = usageMatch[1];
    const totalTokens = usageBlock.match(/total_tokens:\s*(\d+)/)?.[1];
    const toolUses = usageBlock.match(/tool_uses:\s*(\d+)/)?.[1];
    const durationMs = usageBlock.match(/duration_ms:\s*(\d+)/)?.[1];
    usage = {
      ...(totalTokens && { totalTokens: parseInt(totalTokens, 10) }),
      ...(toolUses && { toolUses: parseInt(toolUses, 10) }),
      ...(durationMs && { durationMs: parseInt(durationMs, 10) }),
    };
  }
  return {
    status,
    result: resultMatch ? resultMatch[1].trim() : "",
    usage,
  };
}

const AGENT_ID_RE = /agentId:\s*([\w-]+)/;
export function extractAgentId(text: string): string | null {
  return text.match(AGENT_ID_RE)?.[1] ?? null;
}
