import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import * as Sentry from "@sentry/node";

import type { gateTransport as GateTransport } from "@/lib/sentry/gated-transport";
import type {
  setCrashReportChoice as SetCrashReportChoice,
  CrashReportChoice,
} from "@/lib/sentry/enabled";
import type { reportNativeCrash as ReportNativeCrash } from "@/lib/sentry/native-crash";

// lib/sentry/native-crash.ts#reportNativeCrash is the Electron MAIN-process
// crash reporter. Its header comment explains it deliberately never calls
// Sentry.init() itself — it reuses whatever global @sentry/node client
// sentry.server.config.ts already created in-process (that config file is
// what wires `transport: gateTransport(Sentry.makeNodeTransport)`), and the
// claim that main-process crashes are therefore ALSO suppressed by the
// crash-report opt-out has only ever been argued from that shared-client
// reasoning — never exercised end to end. This file closes that gap.
//
// Unlike __tests__/unit/sentry/native-crash.test.ts (which mocks "@sentry/node"
// entirely to isolate reportNativeCrash's own branching), this is an
// INTEGRATION test: a real `Sentry.init()` from the real @sentry/node SDK,
// with `gateTransport(...)` wrapping a fake inner transport we inject and
// inspect. That is the same shape sentry.server.config.ts wires in
// production, so a pass here is evidence about the real client/gate
// interaction, not about a mock standing in for it.
//
// Same env-ordering hazard as the sibling sentry tests: SENTRY_ENABLED
// (lib/sentry/config.ts) is a module-load-time const computed from
// process.env.NEXT_PUBLIC_LIBI_SENTRY. Every local lib/sentry/* module that
// transitively touches config.ts must therefore be imported AFTER the env
// var is set — hence the dynamic imports in beforeAll, following the pattern
// in gated-transport.test.ts / native-crash.test.ts. "@sentry/node" itself
// has no such env dependency, so it's imported normally at the top and
// shared (un-mocked) across every case in this file.
const ORIGINAL_ENV = { ...process.env };

let gateTransport: typeof GateTransport;
let setCrashReportChoice: typeof SetCrashReportChoice;
let reportNativeCrash: typeof ReportNativeCrash;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_LIBI_SENTRY = "1";
  delete process.env.LIBI_SENTRY_DISABLED;
  delete process.env.NEXT_PUBLIC_LIBI_SENTRY_DISABLED;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;

  ({ gateTransport } = await import("@/lib/sentry/gated-transport"));
  ({ setCrashReportChoice } = await import("@/lib/sentry/enabled"));
  ({ reportNativeCrash } = await import("@/lib/sentry/native-crash"));
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(async () => {
  // Close/flush whatever client the current test initialized before the next
  // test calls Sentry.init() again, so no in-flight state (or a lingering
  // "current client") leaks across cases.
  await Sentry.close(2000).catch(() => {});
  setCrashReportChoice("unset");
});

/**
 * A fake stand-in for a real Sentry transport (same structural shape used by
 * gated-transport.test.ts, verified there against @sentry/core's Transport
 * interface). `send` always "succeeds" so nothing in the SDK's retry/outcome
 * bookkeeping gets in the way of a clean send-count assertion.
 */
function makeFakeTransport() {
  const send = vi.fn((_envelope: unknown) => Promise.resolve({}));
  const flush = vi.fn((_timeout?: number) => Promise.resolve(true));
  const factory = (_options: unknown) => ({ send, flush });
  return { send, flush, factory };
}

/**
 * Initialize a real Sentry client wired exactly like sentry.server.config.ts
 * wires the production one — `transport: gateTransport(makeTransport)` — but
 * with the injected fake factory instead of `Sentry.makeNodeTransport`, and
 * `defaultIntegrations: false` / `tracesSampleRate: 0` to keep the client's
 * footprint (process listeners, background timers) minimal for a test
 * process. The DSN is a syntactically valid placeholder — never dialed, since
 * the transport is fully replaced.
 */
function initClientWith(factory: ReturnType<typeof makeFakeTransport>["factory"]) {
  Sentry.init({
    dsn: "https://abc123@o0.ingest.sentry.io/1",
    defaultIntegrations: false,
    tracesSampleRate: 0,
    transport: gateTransport(factory),
  });
  return Sentry.getClient();
}

/**
 * Fire all three of reportNativeCrash's call shapes (Error, non-Error thrown
 * value, message-only) and wait for the client to finish processing them.
 *
 * reportNativeCrash itself is fire-and-forget: it flushes internally without
 * awaiting ("never await inside a crash handler", per its own comment), and
 * the SDK's capture path is asynchronous too. Sentry.flush() is the SDK's own
 * mechanism for waiting out exactly that: BaseClient.flush() polls until
 * `_numProcessing` (bumped synchronously the moment capture starts) drops to
 * zero, THEN flushes the transport — so it can't race ahead of an event that
 * was already synchronously queued. That is robust in a way a fixed
 * `setTimeout` is not.
 */
async function fireAllShapes() {
  reportNativeCrash("uncaught_exception", { error: new Error("boom") });
  reportNativeCrash("uncaught_exception", { error: "a thrown string, not an Error" });
  reportNativeCrash("uncaught_exception", { message: "plain message, no error object" });
  await Sentry.flush(2000);
}

describe("reportNativeCrash suppression (real Sentry client, injected fake transport)", () => {
  it("choice 'off' — zero sends reach the inner transport, across all three call shapes", async () => {
    const { send, factory } = makeFakeTransport();
    initClientWith(factory);
    setCrashReportChoice("off");

    await fireAllShapes();

    expect(send).not.toHaveBeenCalled();
  });

  it.each<CrashReportChoice>(["on", "unset"])(
    "choice '%s' — all three call shapes DO reach the inner transport (control: proves 'zero sends' when off isn't just 'nothing was captured')",
    async (choice) => {
      const { send, factory } = makeFakeTransport();
      initClientWith(factory);
      setCrashReportChoice(choice);

      await fireAllShapes();

      expect(send).toHaveBeenCalledTimes(3);
    },
  );

  it("the gate is live — flipping 'on' -> 'off' on the SAME client (no re-init) stops the next send", async () => {
    const { send, factory } = makeFakeTransport();
    initClientWith(factory);

    setCrashReportChoice("on");
    reportNativeCrash("uncaught_exception", { error: new Error("sent while opted in") });
    await Sentry.flush(2000);
    expect(send).toHaveBeenCalledTimes(1);

    setCrashReportChoice("off");
    reportNativeCrash("uncaught_exception", { error: new Error("dropped after opting out") });
    await Sentry.flush(2000);
    expect(send).toHaveBeenCalledTimes(1); // unchanged — second call never reached the transport
  });
});
