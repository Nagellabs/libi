// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  useCrashReportSettings,
  useSetCrashReportsEnabled,
  crashReportSettingsKeys,
  type CrashReportSettingDto,
} from "@/lib/queries/crash-report-settings";
import {
  CRASH_REPORTS_STORAGE_KEY,
  crashReportChoiceAllowsReporting,
  getCrashReportChoice,
  setCrashReportChoice,
} from "@/lib/sentry/enabled";

/**
 * The user-preference leg of `shouldSendCrashReports()`. Asserted instead of
 * calling `shouldSendCrashReports()` itself because that also consults
 * `SENTRY_ENABLED`, a module-level const frozen from env at import time — so it
 * cannot be flipped from a `beforeEach`. The build-gate / kill-switch legs have
 * their own coverage in __tests__/unit/sentry/enabled.test.ts, which resets
 * modules per case. What this file is here to prove is that the MUTATION moves
 * the cached choice.
 */
const gateAllowsReporting = () => crashReportChoiceAllowsReporting(getCrashReportChoice());

// The assertion whose absence let the original bug through: the mutation used to
// write only the localStorage MIRROR, leaving the LIVE in-process gate
// (lib/sentry/enabled.ts#cachedChoice, seeded once at Sentry init in
// instrumentation-client.ts) untouched. A renderer therefore kept shipping
// envelopes after the user opted out, until a hard reload — for an Electron
// renderer, potentially days — while the privacy policy promises the opt-out
// "takes effect immediately, mid-session, with no restart".

const fetchMock = vi.fn();

function jsonRes(body: CrashReportSettingDto) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

function wrap() {
  const qc = new QueryClient({
    // No `gcTime: 0` here: with no mounted observer for this key, a 0 gcTime
    // evicts the entry the mutation's `setQueryData` just wrote before the
    // assertion can read it.
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const Wrapper = ({ children }: { children: React.ReactNode }) =>
    React.createElement(QueryClientProvider, { client: qc }, children);
  return { qc, Wrapper };
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  window.localStorage.clear();
  // Start from the shipped default so each test's assertion is about the
  // mutation moving the gate, not about leftover state.
  setCrashReportChoice("unset");
});

describe("useSetCrashReportsEnabled — moves the LIVE browser gate", () => {
  it("opting out flips the in-process gate, not just the localStorage mirror", async () => {
    fetchMock.mockResolvedValue(jsonRes({ choice: "off", decidedAt: 123 }));
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useSetCrashReportsEnabled(), { wrapper: Wrapper });

    expect(getCrashReportChoice()).toBe("unset");

    result.current.mutate(false);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // The live gate — this is the assertion that was missing.
    expect(getCrashReportChoice()).toBe("off");
    // And the effective decision the gated transport reads per envelope.
    expect(gateAllowsReporting()).toBe(false);
    // The persisted mirror (correct on the NEXT launch) still gets written too.
    expect(window.localStorage.getItem(CRASH_REPORTS_STORAGE_KEY)).toBe("off");
  });

  it("opting back in re-opens the live gate in the same session", async () => {
    setCrashReportChoice("off");
    fetchMock.mockResolvedValue(jsonRes({ choice: "on", decidedAt: 456 }));
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useSetCrashReportsEnabled(), { wrapper: Wrapper });

    result.current.mutate(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getCrashReportChoice()).toBe("on");
    expect(gateAllowsReporting()).toBe(true);
    expect(window.localStorage.getItem(CRASH_REPORTS_STORAGE_KEY)).toBe("on");
  });

  it("sends the boolean as the wire 'on'/'off' choice and seeds the query cache", async () => {
    fetchMock.mockResolvedValue(jsonRes({ choice: "off", decidedAt: 789 }));
    const { qc, Wrapper } = wrap();
    const { result } = renderHook(() => useSetCrashReportsEnabled(), { wrapper: Wrapper });

    result.current.mutate(false);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/settings/crash-reports");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ choice: "off" });
    expect(qc.getQueryData(crashReportSettingsKeys.all)).toEqual({
      choice: "off",
      decidedAt: 789,
    });
  });

  it("does not let a stale in-flight READ undo the choice this mutation just made", async () => {
    // Ordering hazard, concretely: Settings mounts and GETs "off"; before that
    // response lands the user flips the switch back ON and the PUT wins. The
    // read's reconcile must decline, not resurrect the "off".
    setCrashReportChoice("off");
    let releaseRead: (r: Response) => void = () => {};
    const readPromise = new Promise<Response>((resolve) => {
      releaseRead = resolve;
    });
    fetchMock.mockImplementation((_url: string, init?: RequestInit) =>
      init?.method === "PUT"
        ? Promise.resolve(jsonRes({ choice: "on", decidedAt: 2 }))
        : readPromise,
    );

    const { Wrapper } = wrap();
    const read = renderHook(() => useCrashReportSettings(), { wrapper: Wrapper });
    const write = renderHook(() => useSetCrashReportsEnabled(), { wrapper: Wrapper });

    write.result.current.mutate(true);
    await waitFor(() => expect(write.result.current.isSuccess).toBe(true));
    expect(getCrashReportChoice()).toBe("on");

    releaseRead(jsonRes({ choice: "off", decidedAt: 1 }));
    await waitFor(() => expect(read.result.current.isSuccess).toBe(true));

    // The write is newer information than a read that started earlier.
    expect(getCrashReportChoice()).toBe("on");
    expect(gateAllowsReporting()).toBe(true);
  });

  it("leaves the live gate alone when the request fails (no optimistic drop)", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useSetCrashReportsEnabled(), { wrapper: Wrapper });

    result.current.mutate(false);
    await waitFor(() => expect(result.current.isError).toBe(true));

    // The server never recorded the choice, so the client must not diverge
    // from it: onSuccess is the only place the gate moves.
    expect(getCrashReportChoice()).toBe("unset");
    expect(window.localStorage.getItem(CRASH_REPORTS_STORAGE_KEY)).toBeNull();
  });
});

// The gap this covers: the READ hook fetched the authoritative value and then
// did nothing with it. Only the mutation moved the gate, so a renderer whose
// localStorage mirror was absent or stale kept reporting against a persisted
// "off" — and this very tab would render the switch OFF while doing so.
describe("useCrashReportSettings — reconciles the live gate from the server", () => {
  it("closes the gate when the DB says 'off' and the mirror was missing", async () => {
    fetchMock.mockResolvedValue(jsonRes({ choice: "off", decidedAt: 11 }));
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useCrashReportSettings(), { wrapper: Wrapper });

    expect(getCrashReportChoice()).toBe("unset"); // fail-open seed

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(getCrashReportChoice()).toBe("off");
    expect(gateAllowsReporting()).toBe(false);
    // The mirror is repaired, so the next launch is correct at init.
    expect(window.localStorage.getItem(CRASH_REPORTS_STORAGE_KEY)).toBe("off");
  });

  it("re-opens the gate when the DB says 'on' and a stale mirror said 'off'", async () => {
    setCrashReportChoice("off");
    window.localStorage.setItem(CRASH_REPORTS_STORAGE_KEY, "off");
    fetchMock.mockResolvedValue(jsonRes({ choice: "on", decidedAt: 12 }));
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useCrashReportSettings(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    // Two-way authority: the DB outranks the mirror in both directions.
    expect(getCrashReportChoice()).toBe("on");
    expect(window.localStorage.getItem(CRASH_REPORTS_STORAGE_KEY)).toBe("on");
  });

  it("leaves the gate alone when the read fails", async () => {
    setCrashReportChoice("off");
    fetchMock.mockResolvedValue({ ok: false, status: 500 } as unknown as Response);
    const { Wrapper } = wrap();
    const { result } = renderHook(() => useCrashReportSettings(), { wrapper: Wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(getCrashReportChoice()).toBe("off");
  });
});
