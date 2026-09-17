// The default (memoised) paths of provider detection and libi's registration check, which the injected-deps tests
// in detect.test.ts and libi-registration.test.ts deliberately skip. Both read ONE `codex mcp list --json`
// (lib/agents/codex-mcp-listing.ts). codex's listing runs OAuth discovery per HTTP entry (see the
// lib/providers/detect.ts header), so a second, overlapping list is a second round of network calls, and a listing
// that takes codex more than 5 s must still answer both. mcpListJson, the resolver and the MCP port are module
// mocks and Claude's config is a temp CLAUDE_CONFIG_DIR: no real config or codex is read.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type ListOpts = { bin?: string; binArgs?: string[]; codexHome?: string; timeoutMs?: number };
const h = vi.hoisted(() => ({
  home: "",
  list: vi.fn<(opts: ListOpts) => Promise<unknown[] | null>>(),
}));

vi.mock("@/lib/codex-config/codex-cli", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/codex-config/codex-cli")>()),
  mcpListJson: (opts: ListOpts) => h.list(opts),
}));
vi.mock("@/lib/agents/cli/resolve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agents/cli/resolve")>()),
  resolveAgentCli: async () => ({
    path: "/fixture/real/codex",
    realPath: "/fixture/real/codex",
    execPath: "/fixture/real/codex",
    version: "0.160.0",
    meetsMinimum: true,
  }),
}));
vi.mock("@/lib/libi-home", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/libi-home")>()),
  getLibiAgentDir: () => path.join(h.home, "agent"),
  getCurrentMcpPort: () => 3457,
}));
// buildAgentStatus's other collaborators — kept light, the same stand-ins agent-status.test.ts uses, so pulling in
// the real agent-status module here does not also pull in session-manager's whole ACP/process-manager chain.
vi.mock("@/lib/sessions/session-manager", () => ({ getSessionManager: () => ({ getReadiness: () => ({ state: "unknown" }) }) }));
vi.mock("@/lib/agents/acp/agent-registry", () => ({ getAgentConfig: () => undefined, refreshAgentCache: () => undefined }));
vi.mock("@/lib/agents/sign-in-confirmation", () => ({ getSignInConfirmedAt: () => null }));

import { CODEX_MCP_LIST_TIMEOUT_MS, CODEX_MCP_LIST_WAIT_MS } from "@/lib/agents/codex-mcp-listing";
import { __clearLibiRegistrationMemo, detectLibiRegistration, readLibiCodexEntryShape } from "@/lib/agents/libi-registration";
import { __clearProviderMemo, detectProviders } from "@/lib/providers/detect";
import { buildAgentStatus } from "@/lib/agents/agent-status";

const LIBI = { name: "libi", enabled: true, transport: { type: "streamable_http", url: "http://127.0.0.1:3457/mcp?agent=codex" } };
const higgsfield = (auth_status: string) => ({
  name: "higgsfield",
  enabled: true,
  transport: { type: "streamable_http", url: "https://mcp.higgsfield.ai/mcp" },
  auth_status,
});
const ROW = { agent: "codex", name: "higgsfield", providerId: "higgsfield", transport: "http", status: "needs-sign-in" } as const;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Let both readers get past their awaited resolver to the listing, without touching (fake) timers. */
async function settle() {
  for (let i = 0; i < 25; i++) await Promise.resolve();
}

beforeEach(() => {
  h.home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "libi-detect-shared-")));
  fs.mkdirSync(path.join(h.home, "agent"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", h.home);
  vi.stubEnv("CODEX_HOME", path.join(h.home, "codex"));
  h.list.mockReset();
  __clearProviderMemo();
  __clearLibiRegistrationMemo();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  __clearProviderMemo();
  __clearLibiRegistrationMemo();
  fs.rmSync(h.home, { recursive: true, force: true });
});

describe("one codex listing for provider detection and libi's registration check", () => {
  it("concurrent calls from both readers spawn codex once, bounded at 15 s, and each answers from that one listing", async () => {
    const listing = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(listing.promise);
    const providers = detectProviders();
    const registration = detectLibiRegistration({ only: "codex" });
    const secondPoll = detectProviders();
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    expect(h.list).toHaveBeenCalledWith(
      expect.objectContaining({ bin: "/fixture/real/codex", binArgs: [], timeoutMs: CODEX_MCP_LIST_TIMEOUT_MS }),
    );
    listing.resolve([LIBI, higgsfield("not_logged_in")]);
    expect(await providers).toEqual({ connected: [ROW] });
    expect(await secondPoll).toEqual({ connected: [ROW] });
    expect((await registration).codex).toEqual({ state: "connected", url: LIBI.transport.url });
    await detectProviders();
    await detectLibiRegistration({ only: "codex" });
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("a listing that takes longer than 5 s, but less than the bound, still yields the correct registration state and rows", async () => {
    vi.useFakeTimers();
    // Longer than the 5 s libi's registration check used to give the list, which lost this race every time.
    const TOOK_MS = 5_600;
    h.list.mockImplementation(
      (opts) =>
        new Promise((resolve) => {
          const timeout = opts.timeoutMs ?? 2_000;
          // As execFile does: a list still running at its timeout is killed, which mcpListJson answers as null.
          setTimeout(() => resolve(timeout > TOOK_MS ? [LIBI, higgsfield("not_logged_in")] : null), Math.min(TOOK_MS, timeout));
        }),
    );
    const registration = detectLibiRegistration({ only: "codex" });
    const providers = detectProviders();
    await settle();
    await vi.advanceTimersByTimeAsync(TOOK_MS);
    expect((await registration).codex).toEqual({ state: "connected", url: LIBI.transport.url });
    expect(await providers).toEqual({ connected: [ROW] });
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("after a good listing, one that fails keeps the Codex rows and libi's registration from it, both marked stale — never no rows, never unknown or not-connected", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
    h.list.mockResolvedValueOnce([LIBI, higgsfield("not_logged_in")]).mockResolvedValue(null);
    expect(await detectProviders()).toEqual({ connected: [ROW] });
    expect((await detectLibiRegistration({ only: "codex" })).codex.state).toBe("connected");

    vi.setSystemTime(new Date("2026-09-12T10:00:05.100Z"));
    expect(await detectProviders()).toEqual({ connected: [{ ...ROW, stale: true }], codex: "stale" });
    expect((await detectLibiRegistration({ only: "codex" })).codex).toEqual({ state: "connected", url: LIBI.transport.url, stale: true });
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("with no good listing yet, a failed one gives no Codex rows but says codex is unread, and registration reads unknown", async () => {
    h.list.mockResolvedValue(null);
    expect(await detectProviders()).toEqual({ connected: [], codex: "unread" });
    expect((await detectLibiRegistration({ only: "codex" })).codex).toEqual({ state: "unknown" });
  });

  it("a listing still running after the wait serves the last good answer instead of holding the request, and its own answer shows on the next read", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
    h.list.mockResolvedValueOnce([LIBI, higgsfield("not_logged_in")]);
    await detectProviders();

    vi.setSystemTime(new Date("2026-09-12T10:00:05.100Z"));
    const slow = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(slow.promise);
    const providers = detectProviders();
    const registration = detectLibiRegistration({ only: "codex" });
    await settle();
    await vi.advanceTimersByTimeAsync(CODEX_MCP_LIST_WAIT_MS);
    expect(await providers).toEqual({ connected: [{ ...ROW, stale: true }], codex: "stale" });
    expect((await registration).codex).toEqual({ state: "connected", url: LIBI.transport.url, stale: true });

    // Neither stale answer was memoised: codex's own answer (both entries removed) shows at once.
    slow.resolve([]);
    await settle();
    expect(await detectProviders()).toEqual({ connected: [] });
    expect((await detectLibiRegistration({ only: "codex" })).codex).toEqual({ state: "not-connected" });
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("a provider that holds every listing past its bound: poll after poll, cycle after cycle, both readers give the same last known answer — registration never flips to unknown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
    h.list.mockResolvedValueOnce([LIBI, higgsfield("not_logged_in")]);
    expect((await detectLibiRegistration({ only: "codex" })).codex).toEqual({ state: "connected", url: LIBI.transport.url });
    expect(await detectProviders()).toEqual({ connected: [ROW] });

    // From here codex needs ~35 s per listing (a provider answering each discovery request in 4 s), so every run is
    // killed at its bound, which mcpListJson answers as null. The Global setup card polls every 3 s.
    h.list.mockImplementation((opts) => new Promise((resolve) => setTimeout(() => resolve(null), opts.timeoutMs ?? 2_000)));
    await vi.advanceTimersByTimeAsync(5_100);
    const POLL_MS = 3_000;
    const registrations: unknown[] = [];
    const detections: unknown[] = [];
    let longestWaitMs = 0;
    for (let elapsed = 0; elapsed < 75_000; ) {
      const started = Date.now();
      const box: { answer?: [Awaited<ReturnType<typeof detectLibiRegistration>>, Awaited<ReturnType<typeof detectProviders>>] } = {};
      void Promise.all([detectLibiRegistration({ only: "codex" }), detectProviders()]).then((a) => (box.answer = a));
      while (!box.answer) await vi.advanceTimersByTimeAsync(250);
      const waited = Date.now() - started;
      longestWaitMs = Math.max(longestWaitMs, waited);
      registrations.push(box.answer[0].codex);
      detections.push(box.answer[1]);
      const rest = Math.max(0, POLL_MS - waited);
      await vi.advanceTimersByTimeAsync(rest);
      elapsed += waited + rest;
    }

    expect(registrations.length).toBeGreaterThanOrEqual(15);
    for (const codex of registrations) expect(codex).toEqual({ state: "connected", url: LIBI.transport.url, stale: true });
    for (const detection of detections) expect(detection).toEqual({ connected: [{ ...ROW, stale: true }], codex: "stale" });
    // Several killed runs — each poll saw both a run going (slow) and a run's failure memoised (failed) — and no poll
    // was held longer than the wait.
    expect(h.list.mock.calls.length).toBeGreaterThanOrEqual(4);
    expect(longestWaitMs).toBeLessThanOrEqual(CODEX_MCP_LIST_WAIT_MS);
  });

  it("a Retry right after a failed listing asks codex again for both readers, where a plain read inside the memo would not, and everything arriving while it runs joins that one run", async () => {
    h.list.mockResolvedValueOnce(null);
    expect(await detectProviders()).toEqual({ connected: [], codex: "unread" });
    expect((await detectLibiRegistration({ only: "codex" })).codex).toEqual({ state: "unknown" });
    expect(await detectProviders()).toEqual({ connected: [], codex: "unread" });
    expect(h.list).toHaveBeenCalledTimes(1);

    const retried = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(retried.promise);
    const providersRetry = detectProviders({ refresh: true });
    const registrationRetry = detectLibiRegistration({ only: "codex", refresh: true });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    const poll = detectProviders();
    const registrationPoll = detectLibiRegistration({ only: "codex" });
    await settle();
    retried.resolve([LIBI, higgsfield("not_logged_in")]);
    expect(await providersRetry).toEqual({ connected: [ROW] });
    expect(await poll).toEqual({ connected: [ROW] });
    expect((await registrationRetry).codex).toEqual({ state: "connected", url: LIBI.transport.url });
    expect((await registrationPoll).codex).toEqual({ state: "connected", url: LIBI.transport.url });
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("Check again during an in-flight listing that started BEFORE it does not trust that run's (possibly pre-change) answer: it waits for it, then asks exactly once more and serves that, never running two listings at once", async () => {
    const listing = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(listing.promise);
    const first = buildAgentStatus("codex");
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    // "Check again" fires while the first read's listing is still going, from before the click — its
    // eventual answer might predate a `codex mcp add` the user just ran outside libi.
    const checkAgain = buildAgentStatus("codex", { refresh: true });
    await settle();
    // No follow-up yet: it only starts once the older run finishes.
    expect(h.list).toHaveBeenCalledTimes(1);

    const followUp = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(followUp.promise);
    // The older listing finally answers: no libi entry yet.
    listing.resolve([higgsfield("not_logged_in")]);
    expect((await first).libiTools).toEqual({ state: "not-connected" });
    // Its finishing is exactly what lets the follow-up start — never alongside it.
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    // The follow-up sees what the outside `codex mcp add` actually did.
    followUp.resolve([LIBI, higgsfield("not_logged_in")]);
    expect((await checkAgain).libiTools).toEqual({ state: "connected" });
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("Check again during a listing that started at or after the click just joins it — no follow-up", async () => {
    const listing = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(listing.promise);
    // Nothing was running yet, so Check again's own call is what starts this listing.
    const checkAgain = buildAgentStatus("codex", { refresh: true });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    // A plain poll arriving while it runs joins the very same listing.
    const poll = buildAgentStatus("codex");
    await settle();
    listing.resolve([LIBI, higgsfield("not_logged_in")]);
    expect((await checkAgain).libiTools).toEqual({ state: "connected" });
    expect((await poll).libiTools).toEqual({ state: "connected" });
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("a clear while a list runs starts a fresh one, and the older list never answers a later read", async () => {
    const older = deferred<unknown[] | null>();
    const fresh = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(older.promise).mockReturnValueOnce(fresh.promise);
    const before = detectProviders();
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    __clearProviderMemo();
    const after = detectLibiRegistration({ only: "codex" });
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(2));
    fresh.resolve([LIBI, higgsfield("o_auth")]);
    expect((await after).codex.state).toBe("connected");
    older.resolve([higgsfield("not_logged_in")]);
    await before;
    expect(await detectProviders()).toEqual({ connected: [{ ...ROW, status: "connected" }] });
    expect(h.list).toHaveBeenCalledTimes(2);
  });

  it("a setup terminal's clear drops codex's last good listing too, so a failed read after it is unread, not the old rows", async () => {
    h.list.mockResolvedValueOnce([higgsfield("not_logged_in")]).mockResolvedValue(null);
    expect(await detectProviders()).toEqual({ connected: [ROW] });
    __clearProviderMemo();
    expect(await detectProviders()).toEqual({ connected: [], codex: "unread" });
  });
});

describe("the session-start check of libi's own codex entry reads the same listing", () => {
  const DISABLED = { ...LIBI, enabled: false };

  it("answers from a listing another reader just made, with no spawn of its own", async () => {
    h.list.mockResolvedValueOnce([DISABLED, higgsfield("not_logged_in")]);
    await detectProviders();
    expect(await readLibiCodexEntryShape()).toBe("disabled");
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("joins a running listing that takes longer than 5 s (an unauthenticated HTTP entry's discovery) and names the disabled entry once it lands", async () => {
    vi.useFakeTimers();
    const TOOK_MS = 5_600;
    h.list.mockImplementation(
      (opts) =>
        new Promise((resolve) => {
          const timeout = opts.timeoutMs ?? 2_000;
          // As execFile does: a list still running at its timeout is killed, which mcpListJson answers as null.
          setTimeout(() => resolve(timeout > TOOK_MS ? [higgsfield("not_logged_in"), DISABLED] : null), Math.min(TOOK_MS, timeout));
        }),
    );
    const registration = detectLibiRegistration({ only: "codex" });
    const shape = readLibiCodexEntryShape();
    await settle();
    await vi.advanceTimersByTimeAsync(TOOK_MS);
    expect(await shape).toBe("disabled");
    expect((await registration).codex.state).toBe("stale-port");
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("with nothing to read yet, it starts the one run, and the other readers join it", async () => {
    const listing = deferred<unknown[] | null>();
    h.list.mockReturnValueOnce(listing.promise);
    const shape = readLibiCodexEntryShape();
    await vi.waitFor(() => expect(h.list).toHaveBeenCalledTimes(1));
    const providers = detectProviders();
    listing.resolve([DISABLED]);
    expect(await shape).toBe("disabled");
    expect(await providers).toEqual({ connected: [] });
    expect(h.list).toHaveBeenCalledTimes(1);
  });

  it("while codex fails, a last good listing up to a minute old still answers; an older one is no information", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-12T10:00:00Z"));
    h.list.mockResolvedValueOnce([DISABLED]).mockResolvedValue(null);
    expect(await readLibiCodexEntryShape()).toBe("disabled");
    vi.setSystemTime(new Date("2026-09-12T10:00:30Z"));
    expect(await readLibiCodexEntryShape()).toBe("disabled");
    vi.setSystemTime(new Date("2026-09-12T10:01:30Z"));
    expect(await readLibiCodexEntryShape()).toBe("unknown");
    expect(h.list).toHaveBeenCalledTimes(3);
  });
});
