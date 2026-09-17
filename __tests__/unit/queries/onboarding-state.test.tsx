// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

/**
 * What the setup wizard records about itself — the agent picked, the wizard
 * finished — used to go out once and be dropped on any failure, with nothing
 * shown. A lost pick lets a later agent connection count a first-time user as set
 * up. And the cache only caught up on a refetch, so a tab switch in that gap
 * reopened step 1.
 */

const toastError = vi.fn();
vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn(), info: vi.fn() } }));

const { onboardingKeys, useUpdateOnboardingState } = await import("@/lib/queries/onboarding");

const SERVER_STATE = {
  needsPersona: false,
  persona: "developer",
  needsOnboarding: true,
  agentEverConnected: false,
  demoOffered: false,
  wizardAgentChosenAt: "2026-09-13T10:00:00.000Z",
  wizardAgent: "codex",
  wizardFinishedAt: null,
  wizardFinished: false,
};

const fetchMock = vi.fn();
let consoleError: MockInstance;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  consoleError.mockRestore();
});

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retryDelay: 0 } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = renderHook(() => useUpdateOnboardingState(), { wrapper });
  return { qc, result };
}

function answer(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("useUpdateOnboardingState", () => {
  it("puts the server's answer to the save straight into the onboarding state, without waiting on a refetch", async () => {
    fetchMock.mockResolvedValueOnce(answer(SERVER_STATE));
    const { qc, result } = setup();
    act(() => result.current.mutate({ wizardAgentChosen: "codex" }));
    await waitFor(() => expect(qc.getQueryData(onboardingKeys.state)).toEqual(SERVER_STATE));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/onboarding/state",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ wizardAgentChosen: "codex" }) }),
    );
    expect(toastError).not.toHaveBeenCalled();
  });

  it("retries a failed save once, and the retry's answer lands in the onboarding state", async () => {
    fetchMock.mockResolvedValueOnce(answer({ error: "busy" }, 503)).mockResolvedValueOnce(answer(SERVER_STATE));
    const { qc, result } = setup();
    act(() => result.current.mutate({ wizardAgentChosen: "codex" }));
    await waitFor(() => expect(qc.getQueryData(onboardingKeys.state)).toEqual(SERVER_STATE));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toastError).not.toHaveBeenCalled();
  });

  it("a save that fails twice tells the user and logs why, instead of failing silently", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    const { qc, result } = setup();
    act(() => result.current.mutate({ wizardFinished: true }));
    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(toastError.mock.calls[0][0]).toMatch(/couldn't save/i);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining("onboarding"), expect.any(TypeError));
    expect(qc.getQueryData(onboardingKeys.state)).toBeUndefined();
  });
});
