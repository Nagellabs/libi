import { describe, it, expect, afterEach, afterAll, beforeAll, vi } from "vitest";
import type { gateTransport as GateTransport } from "@/lib/sentry/gated-transport";
import type { setCrashReportChoice as SetCrashReportChoice } from "@/lib/sentry/enabled";

// lib/sentry/gated-transport.ts is the DROP mechanism for the crash-report
// opt-out: it wraps the runtime's default Sentry transport so that no envelope
// — error, transaction, standalone span, log, or release-health session —
// performs a network request while the user has opted out. It replaced an
// `integrations`-based gate that (a) was evaluated once at init, so a
// mid-session opt-out kept leaking, and (b) missed standalone Web Vital spans
// entirely.
//
// The two invariants that matter, in both directions:
//   1. disabled → the inner transport's `send` is NEVER called, and the promise
//      still resolves successfully (so the SDK does not retry or warn).
//   2. enabled  → the inner transport's `send` IS called, unchanged.
//
// Same dynamic-import dance as scrub.test.ts: the gate reads
// lib/sentry/config.ts#SENTRY_ENABLED, a module-load-time const off
// process.env.NEXT_PUBLIC_LIBI_SENTRY, so the build gate must be on BEFORE the
// module under test is first imported.
const ORIGINAL_ENV = { ...process.env };

let gateTransport: typeof GateTransport;
let setCrashReportChoice: typeof SetCrashReportChoice;

beforeAll(async () => {
  process.env.NEXT_PUBLIC_LIBI_SENTRY = "1";
  ({ gateTransport } = await import("@/lib/sentry/gated-transport"));
  ({ setCrashReportChoice } = await import("@/lib/sentry/enabled"));
  setCrashReportChoice("unset");
});

afterAll(() => {
  process.env = { ...ORIGINAL_ENV };
});

afterEach(() => {
  setCrashReportChoice("unset");
});

/**
 * A fake stand-in for a real Sentry transport. Shape verified against
 * @sentry/core/build/types/types/transport.d.ts — the `Transport` interface is
 * exactly `send` + `flush` — and against the concrete implementation
 * (`createTransport` in @sentry/core/build/cjs/transports/base.js:70-73 returns
 * `{ send, flush }`).
 */
type FakeEnvelope = [{ sent_at: string }, unknown[]];

function makeFakeTransport() {
  const send = vi.fn((_envelope: FakeEnvelope) => Promise.resolve({ statusCode: 200 }));
  const flush = vi.fn((_timeout?: number) => Promise.resolve(true));
  const factory = vi.fn((options: { url: string }) => ({ send, flush, options }));
  return { send, flush, factory };
}

const ENVELOPE: FakeEnvelope = [{ sent_at: "2026-07-25T00:00:00.000Z" }, []];

describe("gateTransport", () => {
  it("does NOT call the inner transport's send once the user has opted out", async () => {
    const { send, factory } = makeFakeTransport();
    const transport = gateTransport(factory)({ url: "https://sentry.example/1" });

    setCrashReportChoice("off");
    await transport.send(ENVELOPE);

    expect(send).not.toHaveBeenCalled();
  });

  it("still resolves successfully while opted out, with the SDK's empty-result shape", async () => {
    const { factory } = makeFakeTransport();
    const transport = gateTransport(factory)({ url: "https://sentry.example/1" });

    setCrashReportChoice("off");
    // `{}` is what the SDK's own transport resolves with when it has nothing
    // left to send (transports/base.js:25-28) and what Client.sendEnvelope
    // returns when the transport is disabled — i.e. "success, nothing to do":
    // no retry, no rate-limit bookkeeping, no console warning.
    await expect(transport.send(ENVELOPE)).resolves.toEqual({});
  });

  it("calls the inner transport's send, with the envelope unchanged, when reporting is enabled", async () => {
    const { send, factory } = makeFakeTransport();
    const transport = gateTransport(factory)({ url: "https://sentry.example/1" });

    setCrashReportChoice("on");
    await expect(transport.send(ENVELOPE)).resolves.toEqual({ statusCode: 200 });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(ENVELOPE);
  });

  it("treats 'unset' (no choice made yet) as enabled, matching shouldSendCrashReports", async () => {
    const { send, factory } = makeFakeTransport();
    const transport = gateTransport(factory)({ url: "https://sentry.example/1" });

    setCrashReportChoice("unset");
    await transport.send(ENVELOPE);

    expect(send).toHaveBeenCalledTimes(1);
  });

  it("evaluates the gate PER SEND, so a mid-session opt-out takes effect with no re-init", async () => {
    // This is the whole reason the gate moved off the `integrations` option,
    // which is evaluated exactly once at Sentry.init.
    const { send, factory } = makeFakeTransport();
    const transport = gateTransport(factory)({ url: "https://sentry.example/1" });

    setCrashReportChoice("on");
    await transport.send(ENVELOPE);
    expect(send).toHaveBeenCalledTimes(1);

    setCrashReportChoice("off");
    await transport.send(ENVELOPE);
    expect(send).toHaveBeenCalledTimes(1); // unchanged — the second send was dropped

    setCrashReportChoice("on");
    await transport.send(ENVELOPE);
    expect(send).toHaveBeenCalledTimes(2); // and it comes back without a reload
  });

  it("builds the inner transport exactly once, passing the SDK's options through", () => {
    const { factory } = makeFakeTransport();
    const options = { url: "https://sentry.example/1" };

    gateTransport(factory)(options);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(options);
  });

  it("delegates flush to the inner transport, so client shutdown still works while opted out", async () => {
    const { flush, factory } = makeFakeTransport();
    const transport = gateTransport(factory)({ url: "https://sentry.example/1" });

    setCrashReportChoice("off");
    await expect(transport.flush(2000)).resolves.toBe(true);
    expect(flush).toHaveBeenCalledWith(2000);
  });
});
