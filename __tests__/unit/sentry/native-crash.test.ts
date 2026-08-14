import { describe, it, expect, vi, afterEach } from "vitest";

// `reportNativeCrash` is the Electron main-process crash reporter. It must:
//   1. no-op (and never touch Sentry) when Sentry is disabled — the default for
//      contributor clones, so local crashes never ship to the shared project;
//   2. no-op when enabled but no in-process client exists yet (early startup);
//   3. route Errors → captureException and bare messages → captureMessage,
//      tagged source=electron-main, when enabled with a client;
//   4. never throw, even if the Sentry SDK itself throws.
//
// SENTRY_ENABLED is evaluated at module load from env, so each case sets env
// first, then imports fresh via resetModules + dynamic import.

const captureException = vi.fn();
const captureMessage = vi.fn();
const getClient = vi.fn();
const flush = vi.fn(() => Promise.resolve(true));

vi.mock("@sentry/node", () => ({
  getClient: () => getClient(),
  captureException: (...a: unknown[]) => captureException(...a),
  captureMessage: (...a: unknown[]) => captureMessage(...a),
}));

const ORIGINAL_ENV = { ...process.env };

async function loadWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  captureException.mockClear();
  captureMessage.mockClear();
  getClient.mockReset();
  // Default: an in-process client exists. Cases that need "no client" or a
  // throwing SDK override this after loading.
  getClient.mockReturnValue({ flush });
  // Reset the env knobs the gate reads, then apply the case.
  delete process.env.NEXT_PUBLIC_LIBI_SENTRY;
  delete process.env.LIBI_SENTRY_DISABLED;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("@/lib/sentry/native-crash");
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("reportNativeCrash", () => {
  it("no-ops when Sentry is disabled (flag unset)", async () => {
    const { reportNativeCrash } = await loadWith({});
    reportNativeCrash("child_process_gone", { message: "type=GPU reason=crashed" });
    expect(getClient).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("no-ops when the hard kill-switch is set even if opted in", async () => {
    const { reportNativeCrash } = await loadWith({
      NEXT_PUBLIC_LIBI_SENTRY: "1",
      LIBI_SENTRY_DISABLED: "1",
    });
    reportNativeCrash("uncaught_exception", { error: new Error("boom") });
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("no-ops when enabled but no in-process client exists", async () => {
    const { reportNativeCrash } = await loadWith({ NEXT_PUBLIC_LIBI_SENTRY: "1" });
    getClient.mockReturnValue(undefined);
    reportNativeCrash("uncaught_exception", { error: new Error("boom") });
    expect(captureException).not.toHaveBeenCalled();
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it("captures an exception (with stack) and tags the source when enabled", async () => {
    const { reportNativeCrash } = await loadWith({ NEXT_PUBLIC_LIBI_SENTRY: "1" });
    const err = new Error("renderer died");
    reportNativeCrash("render_process_gone", { error: err, level: "fatal" });
    expect(captureException).toHaveBeenCalledTimes(1);
    const [captured, ctx] = captureException.mock.calls[0];
    expect(captured).toBe(err);
    expect(ctx.level).toBe("fatal");
    expect(ctx.tags).toMatchObject({ source: "electron-main", crash_kind: "render_process_gone" });
  });

  it("captures a message when there is no Error object", async () => {
    const { reportNativeCrash } = await loadWith({ NEXT_PUBLIC_LIBI_SENTRY: "1" });
    reportNativeCrash("child_process_gone", {
      message: "type=GPU reason=crashed",
      extra: { exitCode: 139 },
    });
    expect(captureMessage).toHaveBeenCalledTimes(1);
    const [msg, ctx] = captureMessage.mock.calls[0];
    expect(msg).toContain("child_process_gone");
    expect(ctx.tags.crash_kind).toBe("child_process_gone");
    expect(ctx.extra).toMatchObject({ exitCode: 139 });
  });

  it("never throws even if the SDK throws", async () => {
    const { reportNativeCrash } = await loadWith({ NEXT_PUBLIC_LIBI_SENTRY: "1" });
    getClient.mockImplementation(() => {
      throw new Error("sdk exploded");
    });
    expect(() => reportNativeCrash("uncaught_exception", { error: new Error("x") })).not.toThrow();
  });
});
