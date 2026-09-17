// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const replace = vi.fn();
const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace, push }) }));

import { FirstLaunchGate } from "@/components/onboarding/first-launch-gate";
import { onboardingKeys } from "@/lib/queries/onboarding";

/**
 * The glitch this guards: after the persona question, the editor used to paint
 * and then switch to the Agents tab. A first launch now goes to the Agents tab
 * before anything of the editor renders — the editor is the gate's children,
 * and they must never render for a first launch, not even for one frame.
 */

const editorRenders = vi.fn();
function Editor() {
  editorRenders();
  return <div data-testid="editor">editor</div>;
}

/** `retries` keeps React Query's own retries (shortened), as the app runs them. */
function renderGate({ retries = false }: { retries?: boolean } = {}) {
  const qc = new QueryClient({
    defaultOptions: { queries: retries ? { retryDelay: 10 } : { retry: false } },
  });
  render(
    <QueryClientProvider client={qc}>
      <FirstLaunchGate fallback={<div data-testid="editor-loading" />}>
        <Editor />
      </FirstLaunchGate>
    </QueryClientProvider>,
  );
  return qc;
}

function stubState(response: () => Promise<Response>) {
  const fetchMock = vi.fn(async (url: string) => {
    if (url === "/api/onboarding/state") return response();
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const needsPersona = (value: boolean) => async () => new Response(JSON.stringify({ needsPersona: value }), { status: 200 });

beforeEach(() => {
  replace.mockClear();
  push.mockClear();
  editorRenders.mockClear();
  window.history.replaceState(null, "", "/editor");
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("FirstLaunchGate", () => {
  it("paints only the loading screen while the onboarding state is unknown", () => {
    stubState(() => new Promise<Response>(() => {}));
    renderGate();
    expect(screen.getByTestId("editor-loading")).toBeInTheDocument();
    expect(editorRenders).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("a first launch is routed to the Agents tab, and the editor never renders", async () => {
    stubState(needsPersona(true));
    renderGate();
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/agents?tab=agents"));
    expect(replace).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByTestId("editor-loading")).toBeInTheDocument();
    expect(editorRenders).not.toHaveBeenCalled();
  });

  it("a user who never answered, opening a deep link, is sent to the Agents tab carrying the link to come back to", async () => {
    window.history.replaceState(null, "", "/editor?piece=p1&session=s2");
    stubState(needsPersona(true));
    renderGate();
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith("/agents?tab=agents&returnTo=%2Feditor%3Fpiece%3Dp1%26session%3Ds2"),
    );
    expect(editorRenders).not.toHaveBeenCalled();
  });

  it("a returning user gets the editor and is routed nowhere", async () => {
    stubState(needsPersona(false));
    renderGate();
    expect(await screen.findByTestId("editor")).toBeInTheDocument();
    expect(screen.queryByTestId("editor-loading")).toBeNull();
    expect(replace).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("an onboarding state that can't be read never keeps anyone out of the editor", async () => {
    stubState(async () => new Response("{}", { status: 500 }));
    renderGate();
    expect(await screen.findByTestId("editor")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });

  it("a state request that fails shows the editor at once rather than after the retries, which go on quietly without pulling the user out of it", async () => {
    let answerRetry: (res: Response) => void = () => {};
    let calls = 0;
    const fetchMock = stubState(() => {
      calls += 1;
      if (calls === 1) return Promise.resolve(new Response("{}", { status: 500 }));
      return new Promise<Response>((resolve) => {
        answerRetry = resolve;
      });
    });
    const qc = renderGate({ retries: true });

    // The retry has not answered, so the query is still pending — and the editor is already up.
    expect(await screen.findByTestId("editor")).toBeInTheDocument();
    expect(screen.queryByTestId("editor-loading")).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    await act(async () => {
      answerRetry(new Response(JSON.stringify({ needsPersona: true }), { status: 200 }));
    });
    await waitFor(() => expect(qc.getQueryData(onboardingKeys.state)).toEqual({ needsPersona: true }));
    expect(screen.getByTestId("editor")).toBeInTheDocument();
    expect(replace).not.toHaveBeenCalled();
  });
});
