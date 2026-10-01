import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * EL-2, the shell's half: Electron's quit runs libi's shutdown.
 *
 * `before-quit` holds the quit ONCE (preventDefault), awaits the runtime's
 * `shutdownForQuit()` under a bound, then quits again — which then goes
 * through. A runtime without the hook (older, or dev where there is none) is
 * never held. `claimQuitSignals` tells a runtime that has the hook that the
 * shell owns SIGINT/SIGTERM; one without it keeps its own listeners.
 */
import {
  QUIT_SHUTDOWN_BOUND_MS,
  claimQuitSignalsIfSupported,
  installQuitShutdown,
} from "../../../electron/quit-shutdown";

type Handler = (e: { preventDefault: () => void }) => void;

function fakeApp() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    on: vi.fn((event: string, fn: Handler) => {
      handlers.set(event, fn);
    }),
    quit: vi.fn(),
  };
}
function quitEvent() {
  return { preventDefault: vi.fn() };
}

const log = vi.fn();
beforeEach(() => log.mockReset());
afterEach(() => vi.useRealTimers());

describe("claimQuitSignalsIfSupported", () => {
  it("a runtime with both exports is told the shell owns the quit signals", () => {
    const api = { claimQuitSignals: vi.fn(), shutdownForQuit: vi.fn() };
    expect(claimQuitSignalsIfSupported(api, log)).toBe(true);
    expect(api.claimQuitSignals).toHaveBeenCalledTimes(1);
  });

  it("an older runtime (no hook) is left with its own listeners, and the log says so", () => {
    expect(claimQuitSignalsIfSupported({}, log)).toBe(false);
    expect(claimQuitSignalsIfSupported({ claimQuitSignals: vi.fn() }, log)).toBe(false);
    expect(claimQuitSignalsIfSupported(null, log)).toBe(false);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/predates shutdownForQuit/));
  });
});

describe("installQuitShutdown", () => {
  it("holds the first quit, runs the shutdown, then quits for real — and lets that second quit through", async () => {
    const app = fakeApp();
    let finish!: () => void;
    const api = { shutdownForQuit: vi.fn(() => new Promise<boolean>((r) => (finish = () => r(true)))) };
    installQuitShutdown(app, () => api, log);
    const first = quitEvent();
    app.handlers.get("before-quit")!(first);
    expect(first.preventDefault).toHaveBeenCalledTimes(1);
    expect(api.shutdownForQuit).toHaveBeenCalledTimes(1);
    expect(app.quit).not.toHaveBeenCalled();

    // Cmd-Q again while it runs: still held, no second shutdown.
    const again = quitEvent();
    app.handlers.get("before-quit")!(again);
    expect(again.preventDefault).toHaveBeenCalledTimes(1);
    expect(api.shutdownForQuit).toHaveBeenCalledTimes(1);

    finish();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/libi's shutdown finished in \d+ms/));

    const last = quitEvent();
    app.handlers.get("before-quit")!(last);
    expect(last.preventDefault).not.toHaveBeenCalled();
    expect(api.shutdownForQuit).toHaveBeenCalledTimes(1);
  });

  it("quits anyway when the shutdown outlives the bound", async () => {
    vi.useFakeTimers();
    expect(QUIT_SHUTDOWN_BOUND_MS).toBe(10_000);
    const app = fakeApp();
    const api = { shutdownForQuit: vi.fn(() => new Promise<boolean>(() => {})) };
    installQuitShutdown(app, () => api, log);
    app.handlers.get("before-quit")!(quitEvent());
    await vi.advanceTimersByTimeAsync(QUIT_SHUTDOWN_BOUND_MS - 1);
    expect(app.quit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(app.quit).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/did not finish within 10000ms/));
  });

  it("quits anyway when the shutdown throws", async () => {
    const app = fakeApp();
    const api = { shutdownForQuit: vi.fn(async () => { throw new Error("wedged"); }) };
    installQuitShutdown(app, () => api, log);
    app.handlers.get("before-quit")!(quitEvent());
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledTimes(1));
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/shutdown threw: wedged/));
  });

  it("no runtime (dev, or before one loaded) or one without the hook: the quit is never held", () => {
    for (const api of [null, undefined, {}]) {
      const app = fakeApp();
      installQuitShutdown(app, () => api, log);
      const e = quitEvent();
      app.handlers.get("before-quit")!(e);
      expect(e.preventDefault).not.toHaveBeenCalled();
      expect(app.quit).not.toHaveBeenCalled();
    }
  });

  it("keeps the durable before-quit breadcrumb", () => {
    const app = fakeApp();
    installQuitShutdown(app, () => null, log);
    app.handlers.get("before-quit")!(quitEvent());
    expect(log).toHaveBeenCalledWith("app before-quit");
  });
});
