import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// shouldSendCrashReports()'s precedence chain is read live from
// lib/sentry/config.ts#SENTRY_ENABLED, which itself derives from env vars
// at import time — so each precedence case sets env, resets modules, and
// imports fresh. See __tests__/unit/sentry/native-crash.test.ts for the same
// pattern in this codebase.

const ORIGINAL_ENV = { ...process.env };

function resetEnv(overrides: Record<string, string | undefined>) {
  delete process.env.NEXT_PUBLIC_LIBI_SENTRY;
  delete process.env.LIBI_SENTRY_DISABLED;
  delete process.env.NEXT_PUBLIC_LIBI_SENTRY_DISABLED;
  delete process.env.NEXT_PUBLIC_SENTRY_DSN;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

// The gate's cache lives on `globalThis`, deliberately: a production
// `next build` emits two server chunks containing it, and with module-level
// state the API route wrote one copy while the transport gate read another —
// so a runtime opt-out did not take effect until restart (measured: 4 leaked
// envelopes). `vi.resetModules()` therefore no longer clears it, which is the
// whole point, so tests that need a virgin gate clear the slot explicitly.
// Covered directly by gate-shared-across-instances.test.ts.
beforeEach(() => {
  delete (globalThis as unknown as Record<string, unknown>).__libiCrashReportGate;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  delete (globalThis as unknown as Record<string, unknown>).__libiCrashReportGate;
});

describe("shouldSendCrashReports precedence", () => {
  it("build gate off (default contributor clone) -> false regardless of user choice", async () => {
    resetEnv({});
    vi.resetModules();
    const { shouldSendCrashReports, setCrashReportChoice } = await import("@/lib/sentry/enabled");
    setCrashReportChoice("on");
    expect(shouldSendCrashReports()).toBe(false);
  });

  it("hard kill-switch beats an opted-in build + user 'on'", async () => {
    resetEnv({ NEXT_PUBLIC_LIBI_SENTRY: "1", LIBI_SENTRY_DISABLED: "1" });
    vi.resetModules();
    const { shouldSendCrashReports, setCrashReportChoice } = await import("@/lib/sentry/enabled");
    setCrashReportChoice("on");
    expect(shouldSendCrashReports()).toBe(false);
  });

  // Only NEXT_PUBLIC_*-prefixed vars are exposed to the client bundle, so
  // LIBI_SENTRY_DISABLED alone can never reach the browser — where browser
  // tracing, release-health sessions and DOM-path INP spans come from. The
  // launchers mirror it to NEXT_PUBLIC_LIBI_SENTRY_DISABLED, and either name
  // must be sufficient on its own.
  it("the NEXT_PUBLIC_ mirror of the kill-switch is sufficient on its own", async () => {
    resetEnv({ NEXT_PUBLIC_LIBI_SENTRY: "1", NEXT_PUBLIC_LIBI_SENTRY_DISABLED: "1" });
    vi.resetModules();
    const { shouldSendCrashReports, setCrashReportChoice } = await import("@/lib/sentry/enabled");
    setCrashReportChoice("on");
    expect(shouldSendCrashReports()).toBe(false);
  });

  it("SENTRY_KILL_SWITCHED is true for either var name and false for neither", async () => {
    resetEnv({ LIBI_SENTRY_DISABLED: "1" });
    vi.resetModules();
    expect((await import("@/lib/sentry/config")).SENTRY_KILL_SWITCHED).toBe(true);

    resetEnv({ NEXT_PUBLIC_LIBI_SENTRY_DISABLED: "1" });
    vi.resetModules();
    expect((await import("@/lib/sentry/config")).SENTRY_KILL_SWITCHED).toBe(true);

    resetEnv({ NEXT_PUBLIC_LIBI_SENTRY: "1" });
    vi.resetModules();
    expect((await import("@/lib/sentry/config")).SENTRY_KILL_SWITCHED).toBe(false);
  });

  it("build gate on, user 'unset' -> true (default enabled)", async () => {
    resetEnv({ NEXT_PUBLIC_LIBI_SENTRY: "1" });
    vi.resetModules();
    const { shouldSendCrashReports, setCrashReportChoice } = await import("@/lib/sentry/enabled");
    setCrashReportChoice("unset");
    expect(shouldSendCrashReports()).toBe(true);
  });

  it("build gate on, user 'on' -> true", async () => {
    resetEnv({ NEXT_PUBLIC_LIBI_SENTRY: "1" });
    vi.resetModules();
    const { shouldSendCrashReports, setCrashReportChoice } = await import("@/lib/sentry/enabled");
    setCrashReportChoice("on");
    expect(shouldSendCrashReports()).toBe(true);
  });

  it("build gate on, user explicit 'off' -> false", async () => {
    resetEnv({ NEXT_PUBLIC_LIBI_SENTRY: "1" });
    vi.resetModules();
    const { shouldSendCrashReports, setCrashReportChoice } = await import("@/lib/sentry/enabled");
    setCrashReportChoice("off");
    expect(shouldSendCrashReports()).toBe(false);
  });
});

describe("getCrashReportChoice / setCrashReportChoice cache", () => {
  beforeEach(() => vi.resetModules());

  it("defaults to 'unset' before anything seeds it", async () => {
    const { getCrashReportChoice } = await import("@/lib/sentry/enabled");
    expect(getCrashReportChoice()).toBe("unset");
  });

  it("reflects the last seeded value", async () => {
    const { getCrashReportChoice, setCrashReportChoice } = await import("@/lib/sentry/enabled");
    setCrashReportChoice("off");
    expect(getCrashReportChoice()).toBe("off");
    setCrashReportChoice("on");
    expect(getCrashReportChoice()).toBe("on");
  });
});

// The DB is authoritative over the localStorage mirror, so a reconcile has to
// move the gate in BOTH directions — while never resurrecting a value the user
// has since overridden. That last part is the whole reason for the revision
// counter; see enabled.ts#reconcileCrashReportChoice.
describe("reconcileCrashReportChoice — server value vs an in-flight decision", () => {
  const originalWindow = globalThis.window;

  beforeEach(() => {
    vi.resetModules();
    const store = new Map<string, string>();
    globalThis.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      } as unknown as Storage,
    } as unknown as Window & typeof globalThis;
  });

  afterEach(() => {
    if (originalWindow === undefined) {
      // @ts-expect-error -- test-only cleanup of a jsdom-style global
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  it("closes the gate when the mirror said 'unset' but the DB says 'off'", async () => {
    const mod = await import("@/lib/sentry/enabled");
    mod.setCrashReportChoice("unset"); // the init-time seed from an absent mirror
    const rev = mod.getCrashReportChoiceRevision();

    expect(mod.reconcileCrashReportChoice("off", rev)).toBe(true);

    expect(mod.getCrashReportChoice()).toBe("off");
    // …and it repairs the mirror too, so the NEXT launch is right without a
    // round-trip (this is the privacy-mode write-failure recovery path).
    expect(mod.readStoredCrashReportChoice()).toBe("off");
  });

  it("re-opens the gate when the mirror said 'off' but the DB says 'on'", async () => {
    const mod = await import("@/lib/sentry/enabled");
    mod.setCrashReportChoice("off");
    const rev = mod.getCrashReportChoiceRevision();

    expect(mod.reconcileCrashReportChoice("on", rev)).toBe(true);
    expect(mod.getCrashReportChoice()).toBe("on");
    expect(mod.readStoredCrashReportChoice()).toBe("on");
  });

  it("DECLINES a stale 'off' when the user re-enabled while the read was in flight", async () => {
    const mod = await import("@/lib/sentry/enabled");
    mod.setCrashReportChoice("off");
    const rev = mod.getCrashReportChoiceRevision(); // snapshot: read starts

    // The user flips the switch back ON; the PUT wins the race and its
    // onSuccess moves the gate before the older GET resolves.
    mod.setCrashReportChoice("on");

    expect(mod.reconcileCrashReportChoice("off", rev)).toBe(false);
    // The decision the user just made survives — the stale read cannot
    // resurrect the "off" they turned off.
    expect(mod.getCrashReportChoice()).toBe("on");
  });

  it("declines a stale 'on' too — supersession is direction-agnostic", async () => {
    const mod = await import("@/lib/sentry/enabled");
    const rev = mod.getCrashReportChoiceRevision();
    mod.setCrashReportChoice("off"); // user opts out mid-flight

    expect(mod.reconcileCrashReportChoice("on", rev)).toBe(false);
    expect(mod.getCrashReportChoice()).toBe("off");
  });

  it("bumps the revision on every write, so two reads can't both apply blindly", async () => {
    const mod = await import("@/lib/sentry/enabled");
    const start = mod.getCrashReportChoiceRevision();
    mod.setCrashReportChoice("on");
    expect(mod.getCrashReportChoiceRevision()).toBe(start + 1);
    // A successful reconcile is itself a write, so a second reconcile holding
    // the same snapshot is superseded by the first.
    expect(mod.reconcileCrashReportChoice("off", start + 1)).toBe(true);
    expect(mod.reconcileCrashReportChoice("on", start + 1)).toBe(false);
    expect(mod.getCrashReportChoice()).toBe("off");
  });
});

describe("readStoredCrashReportChoice / writeStoredCrashReportChoice", () => {
  const originalWindow = globalThis.window;

  afterEach(() => {
    if (originalWindow === undefined) {
      // @ts-expect-error -- test-only cleanup of a jsdom-style global
      delete globalThis.window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  it("returns 'unset' when off-browser (no window)", async () => {
    vi.resetModules();
    const { readStoredCrashReportChoice } = await import("@/lib/sentry/enabled");
    expect(readStoredCrashReportChoice()).toBe("unset");
  });

  it("write is a no-op when off-browser (no window)", async () => {
    vi.resetModules();
    const { writeStoredCrashReportChoice } = await import("@/lib/sentry/enabled");
    expect(() => writeStoredCrashReportChoice("off")).not.toThrow();
  });

  it("reads back a value written to the localStorage mirror", async () => {
    vi.resetModules();
    const store = new Map<string, string>();
    globalThis.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      } as unknown as Storage,
    } as unknown as Window & typeof globalThis;
    const { readStoredCrashReportChoice, writeStoredCrashReportChoice, CRASH_REPORTS_STORAGE_KEY } =
      await import("@/lib/sentry/enabled");
    writeStoredCrashReportChoice("off");
    expect(store.get(CRASH_REPORTS_STORAGE_KEY)).toBe("off");
    expect(readStoredCrashReportChoice()).toBe("off");
  });

  it("returns 'unset' for an absent or garbage stored value", async () => {
    vi.resetModules();
    const store = new Map<string, string>();
    globalThis.window = {
      localStorage: {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
      } as unknown as Storage,
    } as unknown as Window & typeof globalThis;
    const { readStoredCrashReportChoice, CRASH_REPORTS_STORAGE_KEY } = await import("@/lib/sentry/enabled");
    expect(readStoredCrashReportChoice()).toBe("unset");
    store.set(CRASH_REPORTS_STORAGE_KEY, "yes-please");
    expect(readStoredCrashReportChoice()).toBe("unset");
  });

  it("returns 'unset' when localStorage access throws (privacy mode)", async () => {
    vi.resetModules();
    globalThis.window = {
      localStorage: {
        getItem: () => {
          throw new Error("SecurityError");
        },
        setItem: () => {
          throw new Error("SecurityError");
        },
      } as unknown as Storage,
    } as unknown as Window & typeof globalThis;
    const { readStoredCrashReportChoice, writeStoredCrashReportChoice } = await import("@/lib/sentry/enabled");
    expect(readStoredCrashReportChoice()).toBe("unset");
    expect(() => writeStoredCrashReportChoice("on")).not.toThrow();
  });
});
