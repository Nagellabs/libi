// The one `codex mcp list --json` that provider detection and libi's registration check share
// (lib/agents/codex-mcp-listing.ts): its bound, one run at a time, its memo, and what a slow or failed listing
// answers. mcpListJson is a module mock: no codex is spawned and no CODEX_HOME is read.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

type ListOpts = { bin?: string; binArgs?: string[]; codexHome?: string; timeoutMs?: number };
const h = vi.hoisted(() => ({ list: vi.fn<(opts: ListOpts) => Promise<unknown[] | null>>() }));

vi.mock("@/lib/codex-config/codex-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/codex-config/codex-cli")>()),
  mcpListJson: (opts: ListOpts) => h.list(opts),
}));

import {
  CODEX_MCP_LIST_TIMEOUT_MS,
  CODEX_MCP_LIST_WAIT_MS,
  __clearCodexMcpListing,
  readCodexMcpListing,
} from "@/lib/agents/codex-mcp-listing";

const CMD = { command: "/fixture/node", args: ["/fixture/codex.js"] };
const HOME = "/fixture/codex-home";
const HIGGSFIELD = { name: "higgsfield", enabled: true, transport: { type: "streamable_http", url: "https://mcp.higgsfield.ai/mcp" }, auth_status: "not_logged_in" };
const FAL = { name: "fal-ai", enabled: true, transport: { type: "streamable_http", url: "https://mcp.fal.ai/mcp", bearer_token_env_var: "FAL_KEY" } };
const START = 1_000_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * Instruments `h.list` to control each spawn independently and track how many are in flight at
 * once — the direct way to assert "never two listings at once" instead of inferring it from call
 * counts and timing.
 */
function trackSpawns() {
  let current = 0;
  let max = 0;
  const pending: Array<(entries: unknown[] | null) => void> = [];
  h.list.mockImplementation(
    () =>
      new Promise<unknown[] | null>((resolve) => {
        current++;
        max = Math.max(max, current);
        pending.push((entries) => {
          current--;
          resolve(entries);
        });
      }),
  );
  return {
    maxConcurrent: () => max,
    pendingCount: () => pending.length,
    resolveOldest: (entries: unknown[] | null) => {
      const next = pending.shift();
      if (!next) throw new Error("trackSpawns: no pending spawn to resolve");
      next(entries);
    },
  };
}

/** Drains the microtask queue enough for a chain of `.catch().then().finally()` plus a resumed `await` to settle. */
async function flush(ticks = 10) {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

let t = START;
const now = () => t;
const read = (cmd = CMD) => readCodexMcpListing(cmd, { codexHome: HOME, now });

beforeEach(() => {
  h.list.mockReset();
  __clearCodexMcpListing();
  t = START;
});
afterEach(() => {
  vi.useRealTimers();
  __clearCodexMcpListing();
});

describe("readCodexMcpListing", () => {
  it("runs the given codex's list against the given CODEX_HOME, bounded at 15 s: three times codex's ~5 s discovery bound", async () => {
    h.list.mockResolvedValue([HIGGSFIELD]);
    expect(await read()).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
    expect(CODEX_MCP_LIST_TIMEOUT_MS).toBe(15_000);
    expect(h.list).toHaveBeenCalledTimes(1);
    expect(h.list).toHaveBeenCalledWith(
      expect.objectContaining({ bin: "/fixture/node", binArgs: ["/fixture/codex.js"], codexHome: HOME, timeoutMs: 15_000 }),
    );
  });

  it("callers that arrive while a list runs join it; the memo answers for 5 s, then codex is asked again", async () => {
    const first = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(first.promise).mockResolvedValue([FAL]);
    const a = read();
    const b = read();
    first.resolve([HIGGSFIELD]);
    expect(await a).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
    expect(await b).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
    expect(h.list).toHaveBeenCalledTimes(1);

    t = START + 4_999;
    expect(await read()).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
    expect(h.list).toHaveBeenCalledTimes(1);
    t = START + 5_001;
    expect(await read()).toEqual({ state: "fresh", entries: [FAL] });
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("a list that failed, timed out or printed something else is unread with nothing to fall back on — never an empty listing — and the failure is memoised too", async () => {
    h.list.mockResolvedValue(null);
    expect(await read()).toEqual({ state: "unread" });
    t = START + 4_000;
    expect(await read()).toEqual({ state: "unread" });
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("after a good listing, a failed one answers that listing marked stale, until codex answers again", async () => {
    h.list.mockResolvedValueOnce([HIGGSFIELD]).mockResolvedValueOnce(null).mockResolvedValueOnce(null).mockResolvedValue([FAL]);
    await read();
    t = START + 5_001;
    expect(await read()).toEqual({ state: "stale", entries: [HIGGSFIELD], reason: "failed", readAt: START });
    t = START + 10_002;
    expect(await read()).toEqual({ state: "stale", entries: [HIGGSFIELD], reason: "failed", readAt: START });
    t = START + 15_003;
    expect(await read()).toEqual({ state: "fresh", entries: [FAL] });
  });

  it("a slow list: a caller with a good listing waits 6 s, then gets that listing marked stale; the run goes on and its answer lands in the memo", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.list.mockResolvedValueOnce([HIGGSFIELD]);
    await read();
    t = START + 5_001;
    const slow = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(slow.promise);
    const served = read();
    await vi.advanceTimersByTimeAsync(CODEX_MCP_LIST_WAIT_MS - 1);
    let settled = false;
    void served.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await served).toEqual({ state: "stale", entries: [HIGGSFIELD], reason: "slow", readAt: START });

    const joined = read();
    t = START + 9_000;
    slow.resolve([FAL]);
    expect(await joined).toEqual({ state: "fresh", entries: [FAL] });
    expect(await read()).toEqual({ state: "fresh", entries: [FAL] });
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("with no good listing yet, a caller waits for the slow run itself — the spawn timeout bounds it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const slow = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(slow.promise);
    let settled = false;
    const answer = read().then((value) => ((settled = true), value));
    await vi.advanceTimersByTimeAsync(CODEX_MCP_LIST_WAIT_MS + 1_000);
    expect(settled).toBe(false);
    slow.resolve([HIGGSFIELD]);
    expect(await answer).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
  });

  it("refresh asks codex again inside the memo of a failure, and every read while that run goes — refreshed or not — joins it", async () => {
    const retried = deferred<unknown[] | null>();
    h.list.mockResolvedValueOnce(null).mockReturnValueOnce(retried.promise);
    expect(await read()).toEqual({ state: "unread" });
    t = START + 1_000;
    // A plain read inside the memo is the same failure, with no spawn.
    expect(await read()).toEqual({ state: "unread" });
    expect(h.list).toHaveBeenCalledTimes(1);

    const retry = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true });
    const secondRetry = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true });
    const poll = read();
    expect(h.list).toHaveBeenCalledTimes(2);
    retried.resolve([HIGGSFIELD]);
    for (const answer of [retry, secondRetry, poll]) expect(await answer).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("refresh keeps the last good listing: a Retry of a slow list is still served it after the wait", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    h.list.mockResolvedValueOnce([HIGGSFIELD]);
    await read();
    const slow = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(slow.promise);
    const retry = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true });
    await vi.advanceTimersByTimeAsync(CODEX_MCP_LIST_WAIT_MS);
    expect(await retry).toEqual({ state: "stale", entries: [HIGGSFIELD], reason: "slow", readAt: START });
    slow.resolve([FAL]);
    expect(await read()).toEqual({ state: "fresh", entries: [FAL] });
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("a clear drops the last good listing, so a failure after it is unread, not the old entries", async () => {
    h.list.mockResolvedValueOnce([HIGGSFIELD]).mockResolvedValue(null);
    await read();
    __clearCodexMcpListing();
    expect(await read()).toEqual({ state: "unread" });
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("a clear while a list runs starts a fresh one, and the older run never answers a later caller", async () => {
    const older = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(older.promise).mockResolvedValueOnce([FAL]);
    const before = read();
    __clearCodexMcpListing();
    expect(await read()).toEqual({ state: "fresh", entries: [FAL] });
    older.resolve([HIGGSFIELD]);
    expect(await before).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
    expect(await read()).toEqual({ state: "fresh", entries: [FAL] });
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("another codex, or another CODEX_HOME, is never answered from this one's listing", async () => {
    h.list.mockResolvedValueOnce([HIGGSFIELD]).mockResolvedValueOnce([FAL]).mockResolvedValueOnce([]);
    await read();
    expect(await read({ command: "/other/codex", args: [] })).toEqual({ state: "fresh", entries: [FAL] });
    expect(await readCodexMcpListing({ command: "/other/codex", args: [] }, { codexHome: "/other/home", now })).toEqual({
      state: "fresh",
      entries: [],
    });
    expect(h.list).toHaveBeenCalledTimes(3);
  });

  describe("checkAgain (the wizard's Check again)", () => {
    it("during an older in-flight run: lets it finish unused, then asks exactly once more — never a parallel second run — and serves that", async () => {
      const older = deferred<unknown[] | null>();
      h.list.mockReturnValueOnce(older.promise);
      // No lastGood yet, so this caller just awaits the run directly.
      const olderRun = readCodexMcpListing(CMD, { codexHome: HOME, now });

      t = START + 2_000;
      const checkAgain = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true, checkAgain: true });
      // The follow-up run only starts once the older one finishes — not before, and never alongside it.
      expect(h.list).toHaveBeenCalledTimes(1);
      let checkAgainSettled = false;
      void checkAgain.then(() => (checkAgainSettled = true));
      await Promise.resolve();
      await Promise.resolve();
      expect(checkAgainSettled).toBe(false);

      h.list.mockResolvedValueOnce([FAL]);
      older.resolve([HIGGSFIELD]);
      // The older run's own caller still gets the older (pre-change) answer.
      expect(await olderRun).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
      // Check again gets the follow-up run's answer instead — never the one that predates it.
      expect(await checkAgain).toEqual({ state: "fresh", entries: [FAL] });
      expect(h.list).toHaveBeenCalledTimes(2);
    });

    it("during a run that started at or after the click: joins it directly, no follow-up", async () => {
      const running = deferred<unknown[] | null>();
      h.list.mockReturnValueOnce(running.promise);
      // The in-flight run started later than the moment Check again is about to be pressed at.
      t = START + 5_000;
      const inFlight = readCodexMcpListing(CMD, { codexHome: HOME, now });
      t = START;
      const checkAgain = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true, checkAgain: true });
      running.resolve([HIGGSFIELD]);
      expect(await inFlight).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
      expect(await checkAgain).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
      // One run, joined by both callers — never a second one.
      expect(h.list).toHaveBeenCalledTimes(1);
    });

    it("with nothing already running: starts the one run itself and joins it, no follow-up", async () => {
      h.list.mockResolvedValueOnce([HIGGSFIELD]);
      const checkAgain = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true, checkAgain: true });
      expect(await checkAgain).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
      expect(h.list).toHaveBeenCalledTimes(1);
    });

    // Two (or more) Check again presses that both distrust the same older run each null out their
    // own local `running` after awaiting it — the fix re-reads the shared slot instead of trusting
    // that local variable, so only the caller that resumes first actually spawns the follow-up and
    // the rest join it. `trackSpawns` proves this directly (max concurrent spawns == 1) rather than
    // inferring it from `h.list`'s call count alone.
    describe("concurrent presses — the race this fix closes", () => {
      it("two concurrent Check again presses during an older in-flight run: exactly one follow-up spawn, zero overlap, and both callers get its result", async () => {
        const spawns = trackSpawns();
        const olderRun = readCodexMcpListing(CMD, { codexHome: HOME, now });
        expect(spawns.pendingCount()).toBe(1);

        t = START + 2_000;
        const a = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true, checkAgain: true });
        const b = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true, checkAgain: true });
        // Both distrust the older run and are awaiting it — neither has spawned a follow-up yet.
        expect(spawns.pendingCount()).toBe(1);

        spawns.resolveOldest([HIGGSFIELD]);
        await flush();

        // Exactly one follow-up, shared by both callers — never two.
        expect(spawns.pendingCount()).toBe(1);
        expect(spawns.maxConcurrent()).toBe(1);

        spawns.resolveOldest([FAL]);
        expect(await olderRun).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
        expect(await a).toEqual({ state: "fresh", entries: [FAL] });
        expect(await b).toEqual({ state: "fresh", entries: [FAL] });
        expect(h.list).toHaveBeenCalledTimes(2);
      });

      it("three concurrent Check again presses during an older in-flight run: still exactly one follow-up spawn, and every caller gets its result", async () => {
        const spawns = trackSpawns();
        const olderRun = readCodexMcpListing(CMD, { codexHome: HOME, now });

        t = START + 2_000;
        const a = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true, checkAgain: true });
        const b = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true, checkAgain: true });
        const c = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true, checkAgain: true });
        expect(spawns.pendingCount()).toBe(1);

        spawns.resolveOldest([HIGGSFIELD]);
        await flush();

        expect(spawns.pendingCount()).toBe(1);
        expect(spawns.maxConcurrent()).toBe(1);

        spawns.resolveOldest([FAL]);
        expect(await olderRun).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
        for (const answer of [a, b, c]) expect(await answer).toEqual({ state: "fresh", entries: [FAL] });
        expect(h.list).toHaveBeenCalledTimes(2);
      });

      it("a Check again racing a plain poll: the poll joins the older run directly, and Check again still gets exactly one follow-up", async () => {
        const spawns = trackSpawns();
        const olderRun = readCodexMcpListing(CMD, { codexHome: HOME, now });

        t = START + 2_000;
        const checkAgain = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true, checkAgain: true });
        // A plain poll has no reason to distrust the older run — it just joins whatever is running.
        const poll = readCodexMcpListing(CMD, { codexHome: HOME, now });
        expect(spawns.pendingCount()).toBe(1);

        spawns.resolveOldest([HIGGSFIELD]);
        await flush();

        expect(spawns.pendingCount()).toBe(1);
        expect(spawns.maxConcurrent()).toBe(1);

        spawns.resolveOldest([FAL]);
        expect(await olderRun).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
        // The plain poll joined the older run before the follow-up ever existed.
        expect(await poll).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
        // Check again distrusted that same older run and got the follow-up instead.
        expect(await checkAgain).toEqual({ state: "fresh", entries: [FAL] });
        expect(h.list).toHaveBeenCalledTimes(2);
      });

      it("a Check again arriving while a follow-up is already pending joins it, instead of starting a second one", async () => {
        const spawns = trackSpawns();
        const olderRun = readCodexMcpListing(CMD, { codexHome: HOME, now });

        t = START + 2_000;
        const a = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true, checkAgain: true });
        spawns.resolveOldest([HIGGSFIELD]);
        await flush();
        // The follow-up a's press started is now the one in flight.
        expect(spawns.pendingCount()).toBe(1);

        // A second Check again arrives while that follow-up is still pending, at the same moment
        // (per the fake clock) it started — nothing about it can predate this click, so it joins
        // rather than waiting for the follow-up and starting a third.
        const c = readCodexMcpListing(CMD, { codexHome: HOME, now, refresh: true, checkAgain: true });
        await flush();
        expect(spawns.pendingCount()).toBe(1);
        expect(spawns.maxConcurrent()).toBe(1);

        spawns.resolveOldest([FAL]);
        expect(await olderRun).toEqual({ state: "fresh", entries: [HIGGSFIELD] });
        expect(await a).toEqual({ state: "fresh", entries: [FAL] });
        expect(await c).toEqual({ state: "fresh", entries: [FAL] });
        expect(h.list).toHaveBeenCalledTimes(2);
      });
    });
  });
});
