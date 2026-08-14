// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { reconcileCrashReportChoiceFromServer } from "@/lib/sentry/reconcile-client";
import {
  CRASH_REPORTS_STORAGE_KEY,
  getCrashReportChoice,
  setCrashReportChoice,
} from "@/lib/sentry/enabled";

// The gap this closes: instrumentation-client.ts seeds the live gate from the
// localStorage MIRROR, which fails OPEN (reads "unset" = reporting) whenever it
// is absent or stale — a privacy-mode write failure at opt-out time, cleared
// site data, or the server coming up on a different port (localStorage is
// origin-keyed to `localhost:<port>`). Nothing used to correct that, so a user
// with a persisted "off" reported forever, and Settings → Privacy would render
// the switch OFF while that same renderer kept shipping envelopes.

const fetchMock = vi.fn();

function jsonRes(body: unknown, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  window.localStorage.clear();
  setCrashReportChoice("unset");
});

describe("reconcileCrashReportChoiceFromServer", () => {
  it("closes the gate when the DB says 'off' but the mirror was missing", async () => {
    fetchMock.mockResolvedValue(jsonRes({ choice: "off", decidedAt: 1 }));

    expect(getCrashReportChoice()).toBe("unset"); // seed from an absent mirror

    await reconcileCrashReportChoiceFromServer();

    expect(fetchMock).toHaveBeenCalledWith("/api/settings/crash-reports");
    expect(getCrashReportChoice()).toBe("off");
    // The mirror is repaired too, so the next launch is right before any
    // round-trip completes.
    expect(window.localStorage.getItem(CRASH_REPORTS_STORAGE_KEY)).toBe("off");
  });

  it("re-opens the gate when the DB says 'on' but a stale mirror said 'off'", async () => {
    setCrashReportChoice("off");
    window.localStorage.setItem(CRASH_REPORTS_STORAGE_KEY, "off");
    fetchMock.mockResolvedValue(jsonRes({ choice: "on", decidedAt: 2 }));

    await reconcileCrashReportChoiceFromServer();

    // Authority runs DB → mirror, so reconcile must work in BOTH directions.
    expect(getCrashReportChoice()).toBe("on");
    expect(window.localStorage.getItem(CRASH_REPORTS_STORAGE_KEY)).toBe("on");
  });

  it("does not resurrect an 'off' the user turned back on mid-flight", async () => {
    setCrashReportChoice("off");
    let release: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
    );

    const pending = reconcileCrashReportChoiceFromServer();
    // User flips the switch back ON; the PUT's onSuccess moves the gate while
    // the GET above is still outstanding.
    setCrashReportChoice("on");
    release(jsonRes({ choice: "off", decidedAt: 3 }));
    await pending;

    expect(getCrashReportChoice()).toBe("on");
  });

  it("stays silent and leaves the seed alone when the server is unreachable", async () => {
    setCrashReportChoice("off");
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(reconcileCrashReportChoiceFromServer()).resolves.toBeUndefined();
    expect(getCrashReportChoice()).toBe("off");
  });

  it("ignores a non-ok response", async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: "degraded" }, false));

    await reconcileCrashReportChoiceFromServer();

    expect(getCrashReportChoice()).toBe("unset");
  });

  it("ignores a malformed body rather than corrupting the gate", async () => {
    setCrashReportChoice("off");
    fetchMock.mockResolvedValue(jsonRes({ choice: "yes-please" }));

    await reconcileCrashReportChoiceFromServer();

    // A garbage value must not read as "not off".
    expect(getCrashReportChoice()).toBe("off");
  });

  it("swallows a body that isn't JSON at all (an HTML error page)", async () => {
    setCrashReportChoice("off");
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    } as unknown as Response);

    await expect(reconcileCrashReportChoiceFromServer()).resolves.toBeUndefined();
    expect(getCrashReportChoice()).toBe("off");
  });
});
