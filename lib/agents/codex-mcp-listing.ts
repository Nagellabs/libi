/**
 * The one `codex mcp list --json` that both of libi's Codex readers share:
 * provider detection (`lib/providers/detect.ts`) and libi's own registration
 * check (`lib/agents/libi-registration.ts`).
 *
 * The listing is a network call. For every HTTP entry with no bearer token and
 * no stored sign-in, codex runs OAuth discovery against the server to fill
 * `auth_status`. On codex-cli 0.153.4 a server that never answers took 5.05 s,
 * and codex probes entries in parallel (the measurements are in the
 * `lib/providers/detect.ts` header). Two readers spawning it separately paid
 * that twice per poll. The registration check also gave it only 5 s, so it lost
 * that race every time and the Global setup tab read "Couldn't read Codex's
 * config".
 *
 * So there is one listing:
 *
 *   - one bound, `CODEX_MCP_LIST_TIMEOUT_MS` (15 s), well above codex's own
 *     discovery bound;
 *   - one run at a time per codex command and CODEX_HOME. A caller that
 *     arrives while it runs joins it;
 *   - a 5 s memo of the last finished run, whichever reader started it;
 *   - the last GOOD listing is kept. A caller that has one waits at most
 *     `CODEX_MCP_LIST_WAIT_MS` (6 s) for a running listing. After that it gets
 *     the last good listing, marked stale, and the run carries on to fill the
 *     memo. Once codex has answered, a slow provider never holds a request for
 *     the whole bound;
 *   - a run that fails, times out or prints something else is no information,
 *     never "no entries". The answer is the last good listing marked stale, or
 *     `unread` when there is none;
 *   - `refresh` (a Retry) drops the memo, so a failure it still holds is asked
 *     again and every caller after it joins that run. It joins a run already
 *     going rather than start a second, and keeps the last good listing: a
 *     Retry says nothing changed codex's config;
 *   - `checkAgain` (the wizard's Check again) is `refresh` plus one more thing:
 *     Check again implies the user may just have changed codex's config outside
 *     libi (their own `codex mcp add`), so a run already going from BEFORE the
 *     moment Check again was pressed is not trusted as an answer for it — that
 *     run started before the config could have changed. It is let finish, its
 *     answer unused, then exactly one more listing is started and served. A run
 *     already going that started AT OR AFTER that moment (including one this
 *     same call starts because none was running) is joined normally: nothing
 *     about it can predate the click. Either way there is never more than one
 *     listing in flight.
 *
 * `__clearCodexMcpListing` drops all of it, the last good listing included.
 * The clears run after something may have changed codex's config (a setup
 * terminal closing). A listing from before that change would be a wrong
 * answer, not just an old one.
 */
import { serverLogger as logger } from "@/lib/logger";
import { resolveCodexHome } from "@/lib/codex-config/canonical";
import { mcpListJson, type CodexMcpListEntry, type CodexSpawner } from "@/lib/codex-config/codex-cli";
import type { ResolvedBin } from "@/lib/agents/cli/spawn-shape";

/** How long one `codex mcp list --json` may run: well above codex's own ~5 s OAuth-discovery bound. */
export const CODEX_MCP_LIST_TIMEOUT_MS = 15_000;
/** How long a caller that already has a good listing waits for a running one before it is served that listing, marked stale. */
export const CODEX_MCP_LIST_WAIT_MS = 6_000;
/** A finished run answers every caller for this long. */
const MEMO_MS = 5_000;

export type CodexMcpListing =
  | { state: "fresh"; entries: CodexMcpListEntry[] }
  /**
   * Codex's last good listing, from `readAt`. `slow`: the current run was still
   * going after the wait. `failed`: every run since that listing gave no listing.
   */
  | { state: "stale"; entries: CodexMcpListEntry[]; reason: "slow" | "failed"; readAt: number }
  /** No listing, and none since the last clear to fall back on. */
  | { state: "unread" };

/**
 * `codex mcp list --json` run as `cmd` (see `codexSpawnShape` in
 * `lib/agents/libi-registration.ts`) against `codexHome` (default
 * `resolveCodexHome()`), given `timeoutMs` (default `CODEX_MCP_LIST_TIMEOUT_MS`).
 * Unshared: `readCodexMcpListing` is what the readers call.
 */
export function listCodexMcpServers(
  cmd: ResolvedBin,
  opts: { spawner?: CodexSpawner; codexHome?: string; timeoutMs?: number } = {},
): Promise<CodexMcpListEntry[] | null> {
  return mcpListJson({
    bin: cmd.command,
    binArgs: cmd.args,
    codexHome: opts.codexHome ?? resolveCodexHome(),
    timeoutMs: opts.timeoutMs ?? CODEX_MCP_LIST_TIMEOUT_MS,
    spawner: opts.spawner,
  });
}

interface Slot {
  key: string;
  memo: { at: number; entries: CodexMcpListEntry[] | null } | null;
  lastGood: { at: number; entries: CodexMcpListEntry[] } | null;
  failedSinceGood: boolean;
  running: Promise<CodexMcpListEntry[] | null> | null;
  /** When `running` was started — `null` when nothing is running. Cleared together with `running`. */
  runningStartedAt: number | null;
}

/** Replaced, never mutated, by a clear or a different codex: a run keeps writing to the slot it started in, which then serves nobody. */
let slot: Slot | null = null;

/** Drop the memo, the last good listing and any running listing. See the header for when. */
export function __clearCodexMcpListing(): void {
  slot = null;
}

export interface ReadCodexMcpListingOpts {
  /** Default `resolveCodexHome()`. */
  codexHome?: string;
  now?: () => number;
  /** Ask codex again instead of answering from the memo — joining a run already going. See the header. */
  refresh?: boolean;
  /**
   * The wizard's Check again: like `refresh`, plus a run already going from BEFORE this call is
   * not trusted as this call's answer — it may predate a config change the user just made outside
   * libi. See the header. Meaningless without `refresh`, which Check again always sets too.
   */
  checkAgain?: boolean;
}

export async function readCodexMcpListing(cmd: ResolvedBin, opts: ReadCodexMcpListingOpts = {}): Promise<CodexMcpListing> {
  const now = opts.now ?? Date.now;
  const codexHome = opts.codexHome ?? resolveCodexHome();
  const key = JSON.stringify([cmd.command, cmd.args, codexHome]);
  if (!slot || slot.key !== key) {
    slot = { key, memo: null, lastGood: null, failedSinceGood: false, running: null, runningStartedAt: null };
  }
  const s = slot;

  if (opts.refresh) s.memo = null;
  if (s.memo && now() - s.memo.at < MEMO_MS) return answer(s, s.memo.entries);

  const checkAgainAt = opts.checkAgain ? now() : null;
  let running = s.running;
  if (checkAgainAt !== null && running !== null && s.runningStartedAt !== null && s.runningStartedAt < checkAgainAt) {
    // Already going before Check again was pressed: let it finish, unused, then ask exactly once
    // more — never two listings at once — and serve that one. `start()`'s promise never rejects
    // (it already .catch()es internally), so this await needs no guard of its own.
    await running;
    // Re-read the shared slot rather than trusting the local `running` we nulled before the
    // await: a concurrent Check again may have resumed first and already started the follow-up
    // (or, once the microtask that started it has run, another may have joined it too). Joining
    // that same run — instead of unconditionally starting a second one — is what keeps two
    // concurrent Check again presses down to exactly one follow-up.
    running = s.running !== null && s.runningStartedAt !== null && s.runningStartedAt >= checkAgainAt ? s.running : null;
  }
  if (!running) running = start(s, cmd, codexHome, now);
  // Nothing better to serve: wait for the run, which the spawn timeout bounds.
  if (!s.lastGood) return answer(s, await running);

  const waited = await within(running, CODEX_MCP_LIST_WAIT_MS);
  if (waited.done) return answer(s, waited.value);
  logger.debug(
    { tag: "codex-config", op: "list_serve_stale", waitedMs: CODEX_MCP_LIST_WAIT_MS, ageMs: now() - s.lastGood.at },
    "codex mcp list is still running; serving its last good listing",
  );
  return stale(s.lastGood, s.failedSinceGood ? "failed" : "slow");
}

function start(s: Slot, cmd: ResolvedBin, codexHome: string, now: () => number): Promise<CodexMcpListEntry[] | null> {
  const run = listCodexMcpServers(cmd, { codexHome, timeoutMs: CODEX_MCP_LIST_TIMEOUT_MS })
    // mcpListJson never throws; if anything under it ever did, that is still no listing.
    .catch(() => null)
    .then((entries) => {
      const at = now();
      s.memo = { at, entries };
      if (entries) {
        s.lastGood = { at, entries };
        s.failedSinceGood = false;
      } else {
        s.failedSinceGood = true;
      }
      return entries;
    })
    .finally(() => {
      if (s.running === run) {
        s.running = null;
        s.runningStartedAt = null;
      }
    });
  s.running = run;
  s.runningStartedAt = now();
  return run;
}

function answer(s: Slot, entries: CodexMcpListEntry[] | null): CodexMcpListing {
  if (entries) return { state: "fresh", entries };
  return s.lastGood ? stale(s.lastGood, "failed") : { state: "unread" };
}

function stale(lastGood: NonNullable<Slot["lastGood"]>, reason: "slow" | "failed"): CodexMcpListing {
  return { state: "stale", entries: lastGood.entries, reason, readAt: lastGood.at };
}

function within<T>(p: Promise<T>, ms: number): Promise<{ done: true; value: T } | { done: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ done: false }>((resolve) => {
    timer = setTimeout(() => resolve({ done: false }), ms);
  });
  return Promise.race([p.then((value) => ({ done: true as const, value })), timeout]).finally(() => clearTimeout(timer));
}
