/**
 * Authoritative Claude subscription plan usage — the same per-window data
 * Claude Code's `/usage` screen shows (Session 5h, Week all-models, Week
 * Opus/Sonnet), fetched from the claude.ai usage endpoint with the OAuth
 * token Claude Code stores locally on this machine.
 *
 * Why not ACP: claude-agent-acp only forwards `rate_limit_event` snapshots —
 * a single "currently-binding window" figure from API response headers that
 * lags the real numbers and never carries the weekly windows (verified
 * against v0.55.0). The SDK's `getUsage` control request exposes exactly
 * this endpoint's data but is not surfaced over ACP.
 *
 * Token sources (in order): `~/.claude/.credentials.json`
 * (`claudeAiOauth.accessToken`), then the macOS Keychain generic password
 * `"Claude Code-credentials"` (Claude Code's darwin storage). The token is
 * used ONLY as a bearer header here — never logged, never returned to the
 * client, never persisted by libi.
 *
 * Availability contract (user decision 2026-07-05): when the token is not
 * accessible the UI shows NO plan rows — just an explanatory line — so the
 * result is a discriminated union, not nullable data.
 */

import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { serverLogger as logger } from "@/lib/logger";

const execFileAsync = promisify(execFile);

export interface PlanWindow {
  /** Percentage of the window used, 0–100 (null when the endpoint omits it). */
  utilization: number | null;
  /** Epoch seconds when the window resets (null when omitted). */
  resetsAt: number | null;
}

export interface PlanUsageWindows {
  fiveHour: PlanWindow | null;
  sevenDay: PlanWindow | null;
  sevenDayOpus: PlanWindow | null;
  sevenDaySonnet: PlanWindow | null;
}

export type PlanUsageResult =
  | { status: "ok"; windows: PlanUsageWindows }
  /** No readable Claude Code credentials on this machine. */
  | { status: "no_token" }
  /** Token exists but the endpoint call failed (network, 401 on expiry, …). */
  | { status: "error"; httpStatus?: number };

export const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

// ---------------------------------------------------------------------------
// Pure parsers (unit-tested)
// ---------------------------------------------------------------------------

/** Extract the OAuth access token from Claude Code's credentials JSON. */
export function extractAccessToken(credsJson: string): string | null {
  try {
    const parsed = JSON.parse(credsJson) as {
      claudeAiOauth?: { accessToken?: unknown };
    };
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function parseWindow(raw: unknown): PlanWindow | null {
  if (typeof raw !== "object" || raw === null) return null;
  const w = raw as { utilization?: unknown; resets_at?: unknown };
  const utilization =
    typeof w.utilization === "number" && Number.isFinite(w.utilization)
      ? w.utilization
      : null;
  let resetsAt: number | null = null;
  if (typeof w.resets_at === "string") {
    const ms = Date.parse(w.resets_at);
    if (Number.isFinite(ms)) resetsAt = Math.floor(ms / 1000);
  } else if (typeof w.resets_at === "number" && Number.isFinite(w.resets_at)) {
    resetsAt = w.resets_at;
  }
  if (utilization === null && resetsAt === null) return null;
  return { utilization, resetsAt };
}

/**
 * Parse the usage endpoint body. Windows may sit at the top level or under
 * `rate_limits` (the SDK's `getUsage` mirrors the endpoint under that key —
 * accept both so a shape shift doesn't silently blank the popover).
 * Returns null when NO window is recognizable (treated as an error upstream).
 */
export function parsePlanUsageResponse(body: unknown): PlanUsageWindows | null {
  if (typeof body !== "object" || body === null) return null;
  const top = body as Record<string, unknown>;
  const nested =
    typeof top.rate_limits === "object" && top.rate_limits !== null
      ? (top.rate_limits as Record<string, unknown>)
      : null;
  const pick = (key: string): PlanWindow | null =>
    parseWindow(top[key]) ?? (nested ? parseWindow(nested[key]) : null);

  const windows: PlanUsageWindows = {
    fiveHour: pick("five_hour"),
    sevenDay: pick("seven_day"),
    sevenDayOpus: pick("seven_day_opus"),
    sevenDaySonnet: pick("seven_day_sonnet"),
  };
  const any =
    windows.fiveHour || windows.sevenDay || windows.sevenDayOpus || windows.sevenDaySonnet;
  return any ? windows : null;
}

// ---------------------------------------------------------------------------
// Token discovery (never logs or returns the token beyond this module)
// ---------------------------------------------------------------------------

async function readClaudeOAuthToken(): Promise<string | null> {
  // 1. Credentials file (linux + some mac installs)
  try {
    const credsPath = path.join(os.homedir(), ".claude", ".credentials.json");
    const raw = await fs.readFile(credsPath, "utf8");
    const token = extractAccessToken(raw);
    if (token) return token;
  } catch {
    // fall through to keychain
  }
  // 2. macOS Keychain (Claude Code's darwin storage)
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("security", [
        "find-generic-password",
        "-s",
        "Claude Code-credentials",
        "-w",
      ]);
      const token = extractAccessToken(stdout.trim());
      if (token) return token;
    } catch {
      // not present / denied
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Fetch with a small cache (the popover may open often; the endpoint is
// rate-limited infrastructure — don't hammer it)
// ---------------------------------------------------------------------------

const OK_TTL_MS = 60_000;
const FAIL_TTL_MS = 15_000;

let cache: { at: number; result: PlanUsageResult } | null = null;

/** Test seam. */
export function _clearPlanUsageCache(): void {
  cache = null;
}

export async function fetchPlanUsage(): Promise<PlanUsageResult> {
  const now = Date.now();
  if (cache) {
    const ttl = cache.result.status === "ok" ? OK_TTL_MS : FAIL_TTL_MS;
    if (now - cache.at < ttl) return cache.result;
  }

  const result = await fetchPlanUsageUncached();
  cache = { at: now, result };
  return result;
}

async function fetchPlanUsageUncached(): Promise<PlanUsageResult> {
  const token = await readClaudeOAuthToken();
  if (!token) {
    logger.info(
      { tag: "plan-usage", op: "no_token" },
      "Claude Code credentials not accessible — plan usage unavailable",
    );
    return { status: "no_token" };
  }

  let resp: Response;
  try {
    resp = await fetch(CLAUDE_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    logger.warn(
      {
        tag: "plan-usage",
        op: "fetch_failed",
        err: err instanceof Error ? err.message : String(err),
      },
      "claude.ai usage endpoint unreachable",
    );
    return { status: "error" };
  }

  if (!resp.ok) {
    logger.warn(
      { tag: "plan-usage", op: "http_error", httpStatus: resp.status },
      `claude.ai usage endpoint returned HTTP ${resp.status}`,
    );
    return { status: "error", httpStatus: resp.status };
  }

  const body = (await resp.json().catch(() => null)) as unknown;
  const windows = parsePlanUsageResponse(body);
  if (!windows) {
    logger.warn(
      { tag: "plan-usage", op: "parse_failed", keys: body && typeof body === "object" ? Object.keys(body as object).slice(0, 10) : [] },
      "claude.ai usage endpoint returned an unrecognized shape",
    );
    return { status: "error" };
  }
  return { status: "ok", windows };
}
