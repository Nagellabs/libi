/**
 * Agent-speed metrics for a skill-eval run: tool calls (by tool, built-ins included), API
 * turns, input / cache-read / cache-write / output tokens, wall time, cost and success.
 *
 *   tsx scripts/skill-eval/bench-metrics.ts <reportDir | runsDir | file.jsonl>... [--json]
 *
 * A directory is searched for run reports (a `result.json` beside an `agent-jsonl/` folder,
 * which the harness writes for every run); a `.jsonl` is read as one Claude Code session log.
 * Prints one row per run and the medians.
 *
 * The source of truth is the inner agent's own Claude Code session log, not libi's chat
 * messages: only the log carries `usage`. Claude Code writes ONE line per content block and
 * repeats the message's `usage` on each, so summing lines over-counts about 3× — usage is
 * deduplicated by `message.id` here (docs-local/research/2026-10-03-dreams-session-analysis.md
 * §1.1). Tool calls are deduplicated by the `tool_use` block id.
 *
 * Codex (`--agent codex`) is read from its ROLLOUT files, `<CODEX_HOME>/sessions/YYYY/MM/DD/
 * rollout-*.jsonl`, which the harness copies into the same `agent-jsonl/` folder (see
 * `metricsFromCodexRollouts`): API turns and tokens from the `token_count` events, tool calls
 * from the `exec` (Code Mode) calls and the libi tools inside them. A `.jsonl` whose first line
 * is a `session_meta` is read as a Codex rollout. To read raw rollouts of an earlier run by
 * time window: `--codex <sinceISO> <untilISO> [--cwd <substring>] [--codex-home <dir>]`.
 *
 * Pure parsing is exported for the unit test; nothing here imports `@/lib`.
 */
import { existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

export interface TokenTotals {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface TurnMetrics extends TokenTotals {
  /** 1 = the prompt, 2 = the first scripted reply, … */
  turn: number;
  apiTurns: number;
  toolCalls: number;
  /** Seconds from the turn's user message to the turn's end. */
  wallSec: number | null;
}

export interface RunMetrics extends TokenTotals {
  apiTurns: number;
  toolCalls: number;
  /** Calls per tool, libi tools as `libi.<name>`, other MCP tools as `<server>:<tool>`. */
  toolsByName: Record<string, number>;
  /** Models seen, with their API-turn counts. */
  models: Record<string, number>;
  /** First user message → last assistant message, seconds. */
  wallSec: number | null;
  perTurn: TurnMetrics[];
  /** The harness's verdict and cost, when read from a run report. */
  success?: boolean;
  cost?: { amount: number; currency: string } | null;
  /** Harness wall time (prompt sent → last turn complete), seconds. */
  harnessSec?: number;
  source?: string;
  /** Which agent's log this was read from (absent = Claude Code, the original reader). */
  agent?: "claude-code" | "codex";
  /** Codex only — see `CodexExtras`. */
  codex?: CodexExtras;
}

/**
 * What only a Codex rollout can say. Codex runs in Code Mode: the model's one tool is `exec`,
 * where it writes JavaScript, and every libi tool is a call INSIDE that script
 * (`tools.mcp__libi__libi_<name>(…)`). So `RunMetrics.toolCalls` / `toolsByName` count the
 * calls that script made (libi tools as `libi.<name>`), not the `exec` wrappers.
 */
export interface CodexExtras {
  /** `exec` invocations (each is one model-written script; it may make many calls, or none). */
  execCalls: number;
  /** Top-level calls that are not `exec` (`wait`, a direct function tool, …), by name. */
  otherTopLevel: Record<string, number>;
  /** libi tool calls, however reached. */
  libiCalls: number;
  /**
   * Where the nested-call counts come from: `executed` = the studio's own record of the calls
   * the scripts actually made (a loop over six pieces counts six), `source` = the script text
   * (a loop counts once — a LOWER BOUND; the rollout does not record nested calls).
   */
  nestedSource: "executed" | "source";
  /** libi calls visible in the script text, whatever `nestedSource` is. */
  libiCallsInSource: number;
  /** `exec` scripts that read the tool list (`ALL_TOOLS`) — Codex's tool discovery. */
  allToolsLookups: number;
  /** Reasoning tokens (a SUBSET of `output`). */
  reasoning: number;
  /** `input_tokens` as reported, cached share included (`RunMetrics.input` is the uncached part). */
  inputIncludingCached: number;
  /** Input tokens of the first request: the fixed context a chat starts with. */
  firstRequestInput: number | null;
  /** Rollout files read (the root session and any sub-agent it forked). */
  rollouts: number;
}

/** One ACP tool call as the studio's chat recorded it (`acp-tool-calls.json`). */
export interface AcpToolCall {
  toolCallId?: string;
  /** `libi:libi.<tool>` for a libi call, null for a built-in (shell, file read, …). */
  toolId: string | null;
  title?: string;
  startedAt?: number;
  success?: boolean;
}

interface UsageLike {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

interface LogLine {
  type?: string;
  timestamp?: string;
  isMeta?: boolean;
  message?: {
    id?: string;
    model?: string;
    role?: string;
    usage?: UsageLike;
    content?: unknown;
  };
}

/** `mcp__libi__libi_audio_clip` → `libi.audio_clip`; `mcp__zernio__posts_get` → `zernio:posts_get`. */
export function normalizeToolName(name: string): string {
  const libi = /^mcp__(?:libi|libi-app)__libi_(.+)$/.exec(name);
  if (libi) return `libi.${libi[1]}`;
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]}:${mcp[2]}`;
  return name;
}

function n(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function ms(ts: string | undefined): number | null {
  if (!ts) return null;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? null : t;
}

/** A user line that is the person (or the harness standing in for them), not a tool result or an injected skill body. */
function isPromptLine(o: LogLine): boolean {
  if (o.type !== "user" || o.isMeta) return false;
  const c = o.message?.content;
  if (typeof c === "string") return true;
  if (!Array.isArray(c)) return false;
  return c.some((b) => (b as { type?: string }).type === "text") && !c.some((b) => (b as { type?: string }).type === "tool_result");
}

interface ApiMessage {
  id: string;
  model: string;
  firstTs: number | null;
  lastTs: number | null;
  usage: TokenTotals;
}

/**
 * Metrics from one or more Claude Code session logs (a session and its subagent logs).
 *
 * `turnWindows` (ISO pairs from the harness, prompt first) buckets API messages into turns by
 * timestamp. Without it, turns are split at each prompt-like user line — good enough for a
 * log read on its own, but a skill body or a hook's injected text can look like a prompt.
 */
export function metricsFromClaudeLogs(
  logs: string[],
  turnWindows?: ReadonlyArray<{ startedAt: string; endedAt: string }>,
): RunMetrics {
  const messages = new Map<string, ApiMessage>();
  const toolUses = new Map<string, { name: string; ts: number | null }>();
  const promptTs: number[] = [];

  for (const log of logs) {
    for (const raw of log.split("\n")) {
      if (!raw.trim()) continue;
      let o: LogLine;
      try {
        o = JSON.parse(raw) as LogLine;
      } catch {
        continue;
      }
      const ts = ms(o.timestamp);
      if (isPromptLine(o) && ts !== null) promptTs.push(ts);
      if (o.type !== "assistant" || !o.message?.id) continue;
      const model = o.message.model ?? "?";
      // An error the CLI wrote itself (no API call behind it).
      if (model === "<synthetic>") continue;
      const id = o.message.id;
      const u = o.message.usage ?? {};
      const prev = messages.get(id);
      const usage: TokenTotals = {
        input: Math.max(prev?.usage.input ?? 0, n(u.input_tokens)),
        cacheRead: Math.max(prev?.usage.cacheRead ?? 0, n(u.cache_read_input_tokens)),
        cacheWrite: Math.max(prev?.usage.cacheWrite ?? 0, n(u.cache_creation_input_tokens)),
        // Streaming can leave an early block's line with a partial count: keep the largest.
        output: Math.max(prev?.usage.output ?? 0, n(u.output_tokens)),
      };
      messages.set(id, {
        id,
        model,
        firstTs: prev?.firstTs ?? ts,
        lastTs: ts ?? prev?.lastTs ?? null,
        usage,
      });
      const content = Array.isArray(o.message.content) ? o.message.content : [];
      for (const b of content as Array<{ type?: string; id?: string; name?: string }>) {
        if (b.type === "tool_use" && b.id && b.name && !toolUses.has(b.id)) {
          toolUses.set(b.id, { name: normalizeToolName(b.name), ts });
        }
      }
    }
  }

  const all = [...messages.values()];
  const sum = (xs: ApiMessage[]): TokenTotals =>
    xs.reduce(
      (acc, m) => ({
        input: acc.input + m.usage.input,
        cacheRead: acc.cacheRead + m.usage.cacheRead,
        cacheWrite: acc.cacheWrite + m.usage.cacheWrite,
        output: acc.output + m.usage.output,
      }),
      { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    );

  const toolsByName: Record<string, number> = {};
  for (const t of toolUses.values()) toolsByName[t.name] = (toolsByName[t.name] ?? 0) + 1;
  const models: Record<string, number> = {};
  for (const m of all) models[m.model] = (models[m.model] ?? 0) + 1;

  // Turn windows: the harness's, or one per prompt line (each running to the next).
  const sortedPrompts = [...promptTs].sort((a, b) => a - b);
  const windows = turnWindowsOf(turnWindows, sortedPrompts);
  const windowOf = (ts: number | null): number => windowIndex(windows, ts);
  const lastAssistantTs = all.reduce<number | null>((acc, m) => (m.lastTs !== null && (acc === null || m.lastTs > acc) ? m.lastTs : acc), null);
  const perTurn: TurnMetrics[] = windows.map((w, i) => {
    const ms_ = all.filter((m) => windowOf(m.firstTs) === i);
    const tools = [...toolUses.values()].filter((t) => windowOf(t.ts) === i);
    const lastInTurn = ms_.reduce<number | null>((acc, m) => (m.lastTs !== null && (acc === null || m.lastTs > acc) ? m.lastTs : acc), null);
    const end = w.end ?? lastInTurn;
    return {
      turn: i + 1,
      apiTurns: ms_.length,
      toolCalls: tools.length,
      ...sum(ms_),
      wallSec: end !== null ? Math.round((end - w.start) / 100) / 10 : null,
    };
  });

  const firstTs = windows[0]?.start ?? sortedPrompts[0] ?? null;
  const lastTs = turnWindows?.length ? ms(turnWindows[turnWindows.length - 1].endedAt) : lastAssistantTs;
  return {
    apiTurns: all.length,
    toolCalls: toolUses.size,
    toolsByName,
    models,
    ...sum(all),
    wallSec: firstTs !== null && lastTs !== null ? Math.round((lastTs - firstTs) / 100) / 10 : null,
    perTurn,
  };
}

interface TurnWindow {
  start: number;
  end: number | null;
}

/** The harness's turn windows, or one window per prompt start (each running to the next). */
function turnWindowsOf(
  turnWindows: ReadonlyArray<{ startedAt: string; endedAt: string }> | undefined,
  promptStarts: readonly number[],
): TurnWindow[] {
  return turnWindows?.length
    ? turnWindows.map((w) => ({ start: ms(w.startedAt) ?? 0, end: ms(w.endedAt) }))
    : promptStarts.map((start, i) => ({ start, end: promptStarts[i + 1] ?? null }));
}

/** The window a timestamp falls in: the last one that started at or before it (0 when none or unknown). */
function windowIndex(windows: readonly TurnWindow[], ts: number | null): number {
  if (ts === null || windows.length === 0) return 0;
  let idx = 0;
  for (let i = 0; i < windows.length; i++) if (ts >= windows[i].start) idx = i;
  return idx;
}

// ---------------------------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------------------------

interface RolloutRow {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    cwd?: string;
    model?: string;
    name?: string;
    call_id?: string;
    input?: unknown;
    arguments?: unknown;
    response_id?: string;
    usage?: CodexUsage;
    info?: { total_token_usage?: CodexUsage; last_token_usage?: CodexUsage } | null;
    started_at?: number;
    completed_at?: number;
  };
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

/** A Codex rollout opens with a `session_meta` line; a Claude Code log never does. */
export function isCodexRollout(text: string): boolean {
  const nl = text.indexOf("\n");
  const first = nl === -1 ? text : text.slice(0, nl);
  try {
    return (JSON.parse(first) as RolloutRow).type === "session_meta";
  } catch {
    return false;
  }
}

/** `tools.<name>(` and `tools["<name>"](` — how a Code Mode script calls a tool. */
const NESTED_CALL = /\btools\.([A-Za-z_$][\w$]*)\s*\(/g;
const NESTED_CALL_BRACKET = /\btools\[\s*["'`]([^"'`]+)["'`]\s*\]\s*\(/g;

/**
 * The tools a Code Mode script calls, in source order, named like Claude's (`libi.<tool>`).
 * TEXTUAL: a call inside a loop or a helper function appears once however often it runs, and
 * one in a branch that never executes still appears — so this is a lower bound for loops and
 * an upper bound for dead code. The studio's own record of executed calls
 * (`acp-tool-calls.json`) is the exact count; this is the fallback when it is absent.
 */
export function nestedCallsInScript(src: string): string[] {
  const hits: Array<{ at: number; name: string }> = [];
  for (const m of src.matchAll(NESTED_CALL)) hits.push({ at: m.index ?? 0, name: normalizeToolName(m[1]) });
  for (const m of src.matchAll(NESTED_CALL_BRACKET)) hits.push({ at: m.index ?? 0, name: normalizeToolName(m[1]) });
  return hits.sort((a, b) => a.at - b.at).map((h) => h.name);
}

/** The script text of a top-level call: `exec`'s `input`, or a function call's `arguments`. */
function scriptOf(p: NonNullable<RolloutRow["payload"]>): string {
  const v = p.input ?? p.arguments;
  return typeof v === "string" ? v : "";
}

/** `libi:libi.add_overlay` → `libi.add_overlay`; another server's tool → `<server>:<tool>`; a built-in (no tool id) → `builtin:<kind>`. */
export function acpToolName(c: AcpToolCall): string {
  if (c.toolId) {
    const i = c.toolId.indexOf(":");
    const server = i === -1 ? "" : c.toolId.slice(0, i);
    const tool = i === -1 ? c.toolId : c.toolId.slice(i + 1);
    if (server === "libi" || server === "libi-app") return tool.startsWith("libi.") ? tool : `libi.${tool}`;
    return server ? `${server}:${tool}` : tool;
  }
  const t = (c.title ?? "").trim();
  if (/^Read file/i.test(t)) return "builtin:read_file";
  if (/^Search/i.test(t)) return "builtin:search";
  if (/^View Image/i.test(t)) return "builtin:view_image";
  if (/^(Edit|Write|Apply|Update|Add|Delete)\b/i.test(t)) return "builtin:edit";
  return "builtin:shell";
}

/**
 * Metrics from one run's Codex rollout files (the root session, plus any sub-agent it forked).
 *
 * - **API turns and tokens** — the `token_count` events' `last_token_usage`, one per model
 *   request. An event is kept once per cumulative total (Codex repeats them) and skipped when
 *   its usage is zero (a forked rollout opens with its parent's total and no usage of its own).
 *   Codex's `input_tokens` INCLUDES the cached part: `input` here is the uncached remainder and
 *   `cacheRead` the cached share, so the columns mean what Claude's do. `output` includes
 *   `reasoning_output_tokens` (also reported on its own). Codex has no cache-write charge.
 *   Rollouts without `token_count` info fall back to `token_usage_record` lines (by response id).
 * - **Tool calls** — see `CodexExtras`. `acpToolCalls` (the harness's `acp-tool-calls.json`)
 *   gives the calls Code Mode scripts actually made; without it the scripts' text is parsed.
 * - **Wall time** — the harness's turn windows, else the root rollout's own task start/complete.
 * - **Cost** — none: Codex reports no price, and a rate card would be a guess. The harness's
 *   `result.cost` is used when an adapter ever reports one.
 *
 * Top-level calls are deduplicated by `call_id` across files, since a fork replays its parent.
 */
export function metricsFromCodexRollouts(
  rollouts: string[],
  turnWindows?: ReadonlyArray<{ startedAt: string; endedAt: string }>,
  acpToolCalls?: readonly AcpToolCall[],
): RunMetrics {
  interface Req {
    ts: number | null;
    model: string;
    usage: CodexUsage;
  }
  const reqs: Req[] = [];
  const records = new Map<string, Req>();
  const topLevel = new Map<string, { name: string; ts: number | null; script: string }>();
  const taskWindows: Array<{ start: number; end: number | null; file: number }> = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  rollouts.forEach((text, fileIdx) => {
    let model = "?";
    const seenTotals = new Set<string>();
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let o: RolloutRow;
      try {
        o = JSON.parse(raw) as RolloutRow;
      } catch {
        continue;
      }
      const ts = ms(o.timestamp);
      if (ts !== null) {
        if (firstTs === null || ts < firstTs) firstTs = ts;
        if (lastTs === null || ts > lastTs) lastTs = ts;
      }
      const p = o.payload;
      if (!p) continue;
      if (o.type === "turn_context" && typeof p.model === "string") {
        model = p.model;
      } else if (o.type === "token_usage_record" && p.response_id && p.usage) {
        if (!records.has(p.response_id)) records.set(p.response_id, { ts, model, usage: p.usage });
      } else if (o.type === "event_msg" && p.type === "token_count" && p.info?.last_token_usage) {
        const last = p.info.last_token_usage;
        const total = p.info.total_token_usage ?? {};
        const key = `${n(total.input_tokens)}/${n(total.cached_input_tokens)}/${n(total.output_tokens)}/${n(total.total_tokens)}`;
        if (seenTotals.has(key)) continue;
        seenTotals.add(key);
        if (n(last.input_tokens) + n(last.output_tokens) === 0) continue;
        reqs.push({ ts, model, usage: last });
      } else if (o.type === "event_msg" && p.type === "task_started" && typeof p.started_at === "number") {
        taskWindows.push({ start: p.started_at * 1000, end: null, file: fileIdx });
      } else if (o.type === "event_msg" && p.type === "task_complete" && typeof p.completed_at === "number") {
        const open = [...taskWindows].reverse().find((w) => w.file === fileIdx && w.end === null);
        if (open) open.end = p.completed_at * 1000;
      } else if (
        o.type === "response_item" &&
        (p.type === "custom_tool_call" || p.type === "function_call") &&
        typeof p.name === "string" &&
        p.call_id &&
        !topLevel.has(p.call_id)
      ) {
        topLevel.set(p.call_id, { name: p.name, ts, script: scriptOf(p) });
      }
    }
  });
  // No token_count at all (an older Codex): the per-response records are the same numbers.
  const requests = reqs.length ? reqs : [...records.values()];

  const uncached = (u: CodexUsage) => Math.max(0, n(u.input_tokens) - n(u.cached_input_tokens));
  const total = (pick: (u: CodexUsage) => number, xs: readonly Req[] = requests) => xs.reduce((a, r) => a + pick(r.usage), 0);
  const models: Record<string, number> = {};
  for (const r of requests) models[r.model] = (models[r.model] ?? 0) + 1;

  // Calls: top-level (`exec` wrappers and the rest), and what the exec scripts called.
  let execCalls = 0;
  let allToolsLookups = 0;
  const otherTopLevel: Record<string, number> = {};
  const sourceNested: Array<{ name: string; ts: number | null }> = [];
  const direct: Array<{ name: string; ts: number | null }> = [];
  for (const t of topLevel.values()) {
    if (t.name === "exec") {
      execCalls++;
      if (/\bALL_TOOLS\b/.test(t.script)) allToolsLookups++;
      for (const name of nestedCallsInScript(t.script)) sourceNested.push({ name, ts: t.ts });
    } else {
      const name = normalizeToolName(t.name);
      otherTopLevel[name] = (otherTopLevel[name] ?? 0) + 1;
      direct.push({ name, ts: t.ts });
    }
  }
  const executed = acpToolCalls && acpToolCalls.length > 0 ? acpToolCalls : null;
  // A direct MCP call (outside Code Mode) is in the studio's record too — count it once.
  const isMcpName = (name: string) => name.startsWith("libi.") || /^[^:]+:[^:]+$/.test(name);
  const nested: Array<{ name: string; ts: number | null }> = executed
    ? executed.map((c) => ({ name: acpToolName(c), ts: c.startedAt ?? null }))
    : sourceNested;
  const effective = [...nested, ...(executed ? direct.filter((d) => !isMcpName(d.name)) : direct)];

  const toolsByName: Record<string, number> = {};
  for (const c of effective) toolsByName[c.name] = (toolsByName[c.name] ?? 0) + 1;

  // Turn windows: the harness's, else the root rollout's own (the first file's task windows).
  let windows: TurnWindow[] = turnWindowsOf(turnWindows, []);
  if (windows.length === 0) {
    const rootFile = taskWindows.length ? Math.min(...taskWindows.map((w) => w.file)) : 0;
    windows = taskWindows
      .filter((w) => w.file === rootFile)
      .sort((a, b) => a.start - b.start)
      .map((w) => ({ start: w.start, end: w.end }));
  }
  const perTurn: TurnMetrics[] = windows.map((w, i) => {
    const inTurn = requests.filter((r) => windowIndex(windows, r.ts) === i);
    const calls = effective.filter((c) => windowIndex(windows, c.ts) === i);
    const lastInTurn = inTurn.reduce<number | null>((acc, r) => (r.ts !== null && (acc === null || r.ts > acc) ? r.ts : acc), null);
    const end = w.end ?? lastInTurn;
    return {
      turn: i + 1,
      apiTurns: inTurn.length,
      toolCalls: calls.length,
      input: total(uncached, inTurn),
      cacheRead: total((u) => n(u.cached_input_tokens), inTurn),
      cacheWrite: total((u) => n(u.cache_write_input_tokens), inTurn),
      output: total((u) => n(u.output_tokens), inTurn),
      wallSec: end !== null ? Math.round((end - w.start) / 100) / 10 : null,
    };
  });
  const start = windows[0]?.start ?? firstTs;
  const end = turnWindows?.length ? ms(turnWindows[turnWindows.length - 1].endedAt) : (windows[windows.length - 1]?.end ?? lastTs);

  return {
    agent: "codex",
    apiTurns: requests.length,
    toolCalls: effective.length,
    toolsByName,
    models,
    input: total(uncached),
    cacheRead: total((u) => n(u.cached_input_tokens)),
    cacheWrite: total((u) => n(u.cache_write_input_tokens)),
    output: total((u) => n(u.output_tokens)),
    wallSec: start !== null && end !== null && end !== undefined ? Math.round((end - start) / 100) / 10 : null,
    perTurn,
    codex: {
      execCalls,
      otherTopLevel,
      libiCalls: effective.filter((c) => c.name.startsWith("libi.")).length,
      nestedSource: executed ? "executed" : "source",
      libiCallsInSource: sourceNested.filter((c) => c.name.startsWith("libi.")).length,
      allToolsLookups,
      reasoning: total((u) => n(u.reasoning_output_tokens)),
      inputIncludingCached: total((u) => n(u.input_tokens)),
      firstRequestInput: requests.length ? n(requests[0].usage.input_tokens) : null,
      rollouts: rollouts.length,
    },
  };
}

/** The first line of a file, read in chunks (a rollout's first line carries the base instructions, tens of KB). */
function firstLine(path: string): string {
  const fd = openSync(path, "r");
  try {
    const chunks: Buffer[] = [];
    const buf = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const read = readSync(fd, buf, 0, buf.length, null);
      if (read <= 0) break;
      const slice = Buffer.from(buf.subarray(0, read));
      const nl = slice.indexOf(0x0a);
      if (nl !== -1) {
        chunks.push(slice.subarray(0, nl));
        break;
      }
      chunks.push(slice);
      total += read;
      if (total > 8 * 1024 * 1024) break;
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** Codex's own home: `CODEX_HOME`, else `~/.codex` — the same rule libi's `resolveCodexHome` and the CLI use. */
export function codexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

/**
 * The rollout files of one run, copied out of Codex's home for the report.
 *
 * Rollouts live in `<codexHome>/sessions/YYYY/MM/DD/rollout-<local time>-<thread id>.jsonl`
 * (the day is LOCAL), so only the days around `[sinceMs, untilMs]` are listed. A rollout belongs
 * to the run when its `session_meta.cwd` contains `cwdIncludes` — the in-app agent's cwd is
 * `<LIBI_HOME>/agent`, and a skill-eval run's home is a unique mkdtemp, so its basename is a
 * match no other session can share. (The libi session id is NOT Codex's thread id, so it cannot
 * be used.) READ-ONLY: Codex's home is only read, never written.
 */
export function findCodexRollouts(opts: {
  codexHome: string;
  sinceMs: number;
  untilMs: number;
  cwdIncludes: string;
}): Array<{ path: string; content: string }> {
  const root = join(opts.codexHome, "sessions");
  if (!existsSync(root)) return [];
  const out: Array<{ path: string; content: string }> = [];
  const DAY = 86_400_000;
  const seen = new Set<string>();
  for (let t = opts.sinceMs - DAY; t <= opts.untilMs + DAY; t += DAY) {
    const d = new Date(t);
    const rel = join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
    if (seen.has(rel)) continue;
    seen.add(rel);
    const dir = join(root, rel);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!/^rollout-.*\.jsonl$/.test(f)) continue;
      const p = join(dir, f);
      let cwd: string | undefined;
      try {
        cwd = (JSON.parse(firstLine(p)) as RolloutRow).payload?.cwd;
      } catch {
        continue;
      }
      if (typeof cwd === "string" && cwd.includes(opts.cwdIncludes)) out.push({ path: join("codex", rel, f), content: readFileSync(p, "utf8") });
    }
  }
  return out;
}

/** Median of the finite numbers in `xs` (null when there are none). */
export function median(xs: Array<number | null | undefined>): number | null {
  const v = xs.filter((x): x is number => typeof x === "number" && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

/** Read one run report directory (`result.json` + `agent-jsonl/` + `acp-tool-calls.json`). */
export function metricsForReportDir(dir: string): RunMetrics {
  const logDir = join(dir, "agent-jsonl");
  const logs = existsSync(logDir)
    ? walk(logDir).filter((f) => f.endsWith(".jsonl")).sort().map((f) => readFileSync(f, "utf8"))
    : [];
  const result = existsSync(join(dir, "result.json"))
    ? (JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as {
        agent?: string;
        hardPass?: boolean;
        status?: string;
        cost?: { amount: number; currency: string } | null;
        durationSec?: number;
        turnWindows?: Array<{ startedAt: string; endedAt: string }>;
      })
    : null;
  const acpPath = join(dir, "acp-tool-calls.json");
  const acp = existsSync(acpPath) ? (JSON.parse(readFileSync(acpPath, "utf8")) as AcpToolCall[]) : undefined;
  const codex = result?.agent === "codex" || (logs.length > 0 && logs.every(isCodexRollout));
  const m = codex ? metricsFromCodexRollouts(logs, result?.turnWindows, acp) : metricsFromClaudeLogs(logs, result?.turnWindows);
  return {
    ...m,
    ...(result
      ? { success: result.status === "completed" && result.hardPass === true, cost: result.cost ?? null, harnessSec: result.durationSec }
      : {}),
    source: dir,
  };
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

/** Every run report under `root` (a dir holding `result.json`), or `root` itself. */
function findReportDirs(root: string): string[] {
  if (existsSync(join(root, "result.json"))) return [root];
  const out: string[] = [];
  for (const e of readdirSync(root)) {
    const p = join(root, e);
    if (statSync(p).isDirectory()) out.push(...findReportDirs(p));
  }
  return out;
}

const fmtK = (x: number | null) => (x === null ? "—" : x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e3 ? `${(x / 1e3).toFixed(1)}K` : String(Math.round(x)));

export function formatTable(runs: RunMetrics[]): string {
  const head = "| run | ok | wall s | API turns | tool calls | input | cache-read | cache-write | output | cost |";
  const sep = "|---|---|---|---|---|---|---|---|---|---|";
  const row = (label: string, r: Partial<RunMetrics> & TokenTotals, ok: string) =>
    `| ${label} | ${ok} | ${r.wallSec ?? "—"} | ${r.apiTurns ?? "—"} | ${r.toolCalls ?? "—"} | ${fmtK(r.input)} | ${fmtK(r.cacheRead)} | ${fmtK(r.cacheWrite)} | ${fmtK(r.output)} | ${r.cost ? `$${r.cost.amount.toFixed(2)}` : "—"} |`;
  const lines = [head, sep];
  for (const r of runs) lines.push(row(basename(r.source ?? "?"), r, r.success === undefined ? "?" : r.success ? "yes" : "NO"));
  if (runs.length > 1) {
    const med = (k: keyof TokenTotals | "apiTurns" | "toolCalls" | "wallSec") => median(runs.map((r) => r[k] as number | null)) ?? 0;
    const costMed = median(runs.map((r) => r.cost?.amount));
    lines.push(
      row(
        "**median**",
        {
          wallSec: med("wallSec"),
          apiTurns: med("apiTurns"),
          toolCalls: med("toolCalls"),
          input: med("input"),
          cacheRead: med("cacheRead"),
          cacheWrite: med("cacheWrite"),
          output: med("output"),
          cost: costMed === null ? null : { amount: costMed, currency: "USD" },
        },
        `${runs.filter((r) => r.success).length}/${runs.length}`,
      ),
    );
  }
  return lines.join("\n");
}

/** The value after `--flag` (and removes both from `args`), or undefined. */
function takeFlag(args: string[], flag: string, count = 1): string[] | undefined {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  const vals = args.slice(i + 1, i + 1 + count);
  args.splice(i, 1 + count);
  return vals;
}

function main(argv: string[]): void {
  const args = [...argv];
  const json = takeFlag(args, "--json", 0) !== undefined;
  // --codex <since> <until>: raw rollouts by time window instead of a report dir.
  const window = takeFlag(args, "--codex", 2);
  const cwdIncludes = takeFlag(args, "--cwd")?.[0] ?? "";
  const codexHome = takeFlag(args, "--codex-home")?.[0] ?? codexHomeDir();
  const paths = args;
  if (paths.length === 0 && !window) {
    console.error(
      "usage: tsx scripts/skill-eval/bench-metrics.ts <reportDir | runsDir | file.jsonl>... [--json]\n" +
        "       tsx scripts/skill-eval/bench-metrics.ts --codex <sinceISO> <untilISO> [--cwd <substring>] [--codex-home <dir>] [--json]",
    );
    process.exit(1);
  }
  const runs: RunMetrics[] = [];
  if (window) {
    const sinceMs = Date.parse(window[0]);
    const untilMs = Date.parse(window[1]);
    if (Number.isNaN(sinceMs) || Number.isNaN(untilMs)) throw new Error("--codex takes two ISO timestamps");
    const files = findCodexRollouts({ codexHome, sinceMs, untilMs, cwdIncludes })
      .filter((f) => {
        const t = f.content.split("\n", 1)[0];
        const at = Date.parse((JSON.parse(t) as RolloutRow).timestamp ?? "");
        return Number.isNaN(at) || (at >= sinceMs - 60_000 && at <= untilMs);
      });
    runs.push({ ...metricsFromCodexRollouts(files.map((f) => f.content), [{ startedAt: window[0], endedAt: window[1] }]), source: `codex:${window[0]}..${window[1]}` });
  }
  for (const p of paths.map((x) => resolve(x))) {
    if (p.endsWith(".jsonl")) {
      const text = readFileSync(p, "utf8");
      runs.push({ ...(isCodexRollout(text) ? metricsFromCodexRollouts([text]) : metricsFromClaudeLogs([text])), source: p });
    } else for (const d of findReportDirs(p)) runs.push(metricsForReportDir(d));
  }
  if (json) {
    console.log(JSON.stringify(runs, null, 2));
    return;
  }
  console.log(formatTable(runs));
  for (const r of runs) {
    const tools = Object.entries(r.toolsByName).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(", ");
    const turns = r.perTurn.map((t) => `T${t.turn}: ${t.apiTurns} API turns, ${t.toolCalls} calls, ${t.wallSec ?? "—"} s, ${fmtK(t.cacheRead)} cache-read, ${fmtK(t.output)} out`).join(" · ");
    console.log(`\n${r.source}\n  tools: ${tools}\n  ${turns}`);
    if (r.codex) {
      const c = r.codex;
      const other = Object.entries(c.otherTopLevel).map(([k, v]) => `${k} ${v}`).join(", ");
      console.log(
        `  codex: ${c.execCalls} exec scripts (${c.allToolsLookups} read ALL_TOOLS)${other ? `, other top-level: ${other}` : ""} · ${c.libiCalls} libi calls ` +
          `(${c.nestedSource === "executed" ? "executed, from the studio's record" : `from script text — a loop counts once; ${c.libiCallsInSource} in source`}) · ` +
          `reasoning ${fmtK(c.reasoning)} of ${fmtK(r.output)} out · first request ${fmtK(c.firstRequestInput)} in · models ${JSON.stringify(r.models)}`,
      );
    }
  }
}

if (process.argv[1] && /bench-metrics\.ts$/.test(process.argv[1])) main(process.argv.slice(2));
