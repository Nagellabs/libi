/**
 * Pure parse/merge for the two @experimental ACP session updates libi
 * consumes: `usage_update` (context tokens / cost / Claude rate limits) and
 * `available_commands_update` (advertised slash commands).
 *
 * This module is the single defensive seam for both fields — the ACP schema
 * marks them UNSTABLE, and claude-agent-acp additionally smuggles Claude
 * Code's SDKRateLimitInfo through `_meta["_claude/rateLimit"]`. Everything
 * here tolerates drift: malformed input returns the previous state (or an
 * empty list) instead of throwing. No I/O, no logging — callers log.
 *
 * SDKRateLimitInfo is a snapshot of the CURRENTLY BINDING window (one
 * rateLimitType per event), so `rateLimits` accumulates the latest snapshot
 * per window type.
 */

export type RateLimitWindowType =
  | "five_hour"
  | "seven_day"
  | "seven_day_opus"
  | "seven_day_sonnet"
  | "overage";

const RATE_LIMIT_WINDOW_TYPES: ReadonlySet<string> = new Set([
  "five_hour",
  "seven_day",
  "seven_day_opus",
  "seven_day_sonnet",
  "overage",
]);

export type RateLimitStatus = "allowed" | "allowed_warning" | "rejected";

export interface RateLimitSnapshot {
  status: RateLimitStatus;
  /** 0–100, or null when the event omitted it. */
  utilization: number | null;
  /** Epoch seconds, or null when the event omitted it. */
  resetsAt: number | null;
  /** Ingest wall-clock (ms). Informational only — never rendered as a timer. */
  updatedAt: number;
}

export interface SessionUsageState {
  /** Tokens currently in the agent's context. */
  used: number;
  /** Total context window size in tokens, after correction (what the UI shows). */
  size: number;
  /** The size exactly as the adapter last reported it, before any correction.
   *  This — never `size` — is what the turn-end recorder persists to the
   *  model-window cache: recording a corrected value would make the cache
   *  self-confirming, and a genuine window downgrade could never displace it. */
  reportedSize: number;
  /** Cumulative session cost when the adapter reports one (ACP Cost shape). */
  cost: { amount: number; currency: string } | null;
  rateLimits: Partial<Record<RateLimitWindowType, RateLimitSnapshot>>;
  updatedAt: number;
}

export interface AvailableCommandInfo {
  /** Command name without the leading slash, e.g. "compact", "mcp:foo". */
  name: string;
  description: string;
  /** Argument hint from AvailableCommandInput, e.g. "instructions". */
  inputHint: string | null;
}

function isRateLimitStatus(v: unknown): v is RateLimitStatus {
  return v === "allowed" || v === "allowed_warning" || v === "rejected";
}

function finiteNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/**
 * Merge one raw `usage_update` into the previous state. Returns `prev`
 * (same reference) when the update is malformed — callers use reference
 * inequality to decide whether to emit.
 */
export function applyUsageUpdate(
  prev: SessionUsageState | null,
  update: unknown,
  now: number = Date.now(),
  knownWindow: number | null = null,
): SessionUsageState | null {
  if (typeof update !== "object" || update === null) return prev;
  const u = update as {
    used?: unknown;
    size?: unknown;
    cost?: unknown;
    _meta?: unknown;
  };

  const used = finiteNumber(u.used);
  const size = finiteNumber(u.size);
  if (used === null || used < 0 || size === null || size <= 0) return prev;

  // used > size is arithmetically impossible against the model's true window
  // (the API would have refused or auto-compacted first), so it marks the
  // reported size as stale — the adapter seeds a 200k default on session/new
  // and on model switches until the first result confirms the real window
  // (claude-agent-acp inferContextWindowFromModel / DEFAULT_CONTEXT_WINDOW).
  // Recover the best size we can prove: the previous window if it can hold
  // `used` (a model switch left the old, correct window behind), then the
  // learned window for this model (persisted at prior turn ends by the
  // model-window cache), else `used` itself, which caps the display at
  // exactly 100%. Separately, a size SMALLER than the learned window while
  // `used` still fits it is the fresh-process default seed nine times out of
  // ten — prefer the learned window; the tenth time (a genuine downgrade)
  // re-records at the end of its first turn and wins from then on. The
  // adapter's authoritative correction still replaces all of this within a
  // turn — except a genuine downgrade to a window smaller than `used`, which
  // is indistinguishable from a stale report and keeps the recovered size
  // until compaction brings `used` back under the true window.
  const effectiveSize = (() => {
    if (used > size) {
      if (prev && prev.size >= used) return prev.size;
      if (knownWindow !== null && knownWindow >= used) return knownWindow;
      return used;
    }
    if (knownWindow !== null && knownWindow > size) return knownWindow;
    return size;
  })();

  // Cost: replace when the update carries a valid Cost, else carry forward.
  let cost = prev?.cost ?? null;
  if (typeof u.cost === "object" && u.cost !== null) {
    const c = u.cost as { amount?: unknown; currency?: unknown };
    const amount = finiteNumber(c.amount);
    if (amount !== null && typeof c.currency === "string" && c.currency) {
      cost = { amount, currency: c.currency };
    }
  }

  // Rate limits: accumulate the latest snapshot per window type.
  const rateLimits: SessionUsageState["rateLimits"] = {
    ...(prev?.rateLimits ?? {}),
  };
  const meta =
    typeof u._meta === "object" && u._meta !== null
      ? (u._meta as Record<string, unknown>)
      : null;
  const rawRl = meta?.["_claude/rateLimit"];
  if (typeof rawRl === "object" && rawRl !== null) {
    const rl = rawRl as {
      status?: unknown;
      rateLimitType?: unknown;
      utilization?: unknown;
      resetsAt?: unknown;
    };
    if (
      typeof rl.rateLimitType === "string" &&
      RATE_LIMIT_WINDOW_TYPES.has(rl.rateLimitType) &&
      isRateLimitStatus(rl.status)
    ) {
      rateLimits[rl.rateLimitType as RateLimitWindowType] = {
        status: rl.status,
        utilization: finiteNumber(rl.utilization),
        resetsAt: finiteNumber(rl.resetsAt),
        updatedAt: now,
      };
    }
  }

  return {
    used,
    size: effectiveSize,
    reportedSize: size,
    cost,
    rateLimits,
    updatedAt: now,
  };
}

/** Map a raw `available_commands_update` to typed command infos. */
export function toAvailableCommands(update: unknown): AvailableCommandInfo[] {
  if (typeof update !== "object" || update === null) return [];
  const arr = (update as { availableCommands?: unknown }).availableCommands;
  if (!Array.isArray(arr)) return [];
  const out: AvailableCommandInfo[] = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) continue;
    const c = item as {
      name?: unknown;
      description?: unknown;
      input?: unknown;
    };
    if (typeof c.name !== "string" || c.name.length === 0) continue;
    const input =
      typeof c.input === "object" && c.input !== null
        ? (c.input as { hint?: unknown })
        : null;
    out.push({
      name: c.name,
      description: typeof c.description === "string" ? c.description : "",
      inputHint: typeof input?.hint === "string" ? input.hint : null,
    });
  }
  return out;
}
