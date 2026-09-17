// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
// The modal must not navigate: it sits over the Agents tab, where setup goes on.
// Mocked so any router use would be observable (Next's throws outside an app router).
const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, replace }) }));

import { PersonaModal } from "@/components/onboarding/persona-modal";

/**
 * The measured bug: `pick()` had no try/catch and no res.ok check. A thrown
 * fetch (offline) skipped `setSaving(false)` entirely, leaving every one of
 * the eight persona buttons permanently disabled — and the modal has no
 * close control by design, so that is a full application lock-up from one
 * failed request. A 4xx/5xx response was silently accepted the same way:
 * `invalidateQueries` ran regardless of `res.ok`, so `needsPersona` stayed
 * true server-side and the modal just sat there with no explanation.
 *
 * These tests must fail against the pre-fix code for the right reason (the
 * "solo creator" button stays disabled forever / no error text appears) —
 * not fail on some unrelated setup problem.
 */

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

/** A persona save that succeeds, and a state that reflects it. */
function savingFetch() {
  let saved = false;
  return vi.fn(async (url: string) => {
    if (url === "/api/onboarding/state") return new Response(JSON.stringify({ needsPersona: !saved }), { status: 200 });
    if (url === "/api/onboarding/persona") {
      saved = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

const TABBABLE = 'button:not([disabled]), a[href], input:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * One press of Tab as a browser performs it: the key goes to the focused element,
 * and unless a handler prevents it, focus moves to the next (or, with Shift, the
 * previous) tabbable element in document order, wrapping around. jsdom moves no
 * focus on a key press by itself.
 */
async function pressTab(shift: boolean) {
  const active = (document.activeElement as HTMLElement | null) ?? document.body;
  const proceed = fireEvent.keyDown(active, { key: "Tab", code: "Tab", shiftKey: shift });
  if (!proceed) return;
  const order = Array.from(document.querySelectorAll<HTMLElement>(TABBABLE)).filter((el) => !el.closest("[inert]"));
  const at = order.indexOf(active);
  const next = shift ? order[(at <= 0 ? order.length : at) - 1] : order[(at + 1) % order.length];
  await act(async () => {
    next.focus();
  });
}

function stubStateFetch(needsPersona: boolean) {
  return vi.fn(async (url: string) => {
    if (url === "/api/onboarding/state") {
      return new Response(JSON.stringify({ needsPersona }), { status: 200 });
    }
    throw new Error(`unexpected fetch in state stub: ${url}`);
  });
}

describe("PersonaModal", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    push.mockClear();
    replace.mockClear();
  });

  it("does not render when the user has already picked a persona", async () => {
    vi.stubGlobal("fetch", stubStateFetch(false));
    wrap(<PersonaModal />);
    await waitFor(() =>
      expect(screen.queryByText(/welcome to libi/i)).not.toBeInTheDocument(),
    );
  });

  it("recovers from a failed save instead of locking every button", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/onboarding/state") {
        return new Response(JSON.stringify({ needsPersona: true }), { status: 200 });
      }
      throw new Error("offline");
    });
    vi.stubGlobal("fetch", fetchMock);

    wrap(<PersonaModal />);
    await screen.findByText(/welcome to libi/i);

    const button = screen.getByRole("button", { name: /solo creator/i });
    fireEvent.click(button);

    // Every other persona button must recover too, not just the clicked one.
    await waitFor(() => expect(button).toBeEnabled());
    for (const label of ["Entrepreneur", "Video editor", "Just curious"]) {
      expect(screen.getByRole("button", { name: new RegExp(label, "i") })).toBeEnabled();
    }

    expect(screen.getByText(/couldn.t save/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("re-enables after a 500 as well as a network error", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/onboarding/state") {
        return new Response(JSON.stringify({ needsPersona: true }), { status: 200 });
      }
      if (url === "/api/onboarding/persona") {
        return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    wrap(<PersonaModal />);
    await screen.findByText(/welcome to libi/i);

    const button = screen.getByRole("button", { name: /solo creator/i });
    fireEvent.click(button);

    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByText(/couldn.t save/i)).toBeTruthy();
  });

  it("clears the error and retries the same persona on Retry click", async () => {
    let personaCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/onboarding/state") {
        return new Response(JSON.stringify({ needsPersona: true }), { status: 200 });
      }
      if (url === "/api/onboarding/persona") {
        personaCalls += 1;
        if (personaCalls === 1) {
          return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        }
        return new Response(JSON.stringify({ ok: true, persona: "solo-creator" }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    wrap(<PersonaModal />);
    await screen.findByText(/welcome to libi/i);

    fireEvent.click(screen.getByRole("button", { name: /solo creator/i }));
    await screen.findByText(/couldn.t save/i);

    fireEvent.click(screen.getByRole("button", { name: /retry/i }));

    await waitFor(() => expect(personaCalls).toBe(2));
  });

  it("a successful pick closes the modal without navigating anywhere; a rejected save keeps it open", async () => {
    let status = 500;
    let personaSaved = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/onboarding/state") {
        return new Response(JSON.stringify({ needsPersona: !personaSaved }), { status: 200 });
      }
      if (url === "/api/onboarding/persona") {
        if (status === 200) personaSaved = true;
        return new Response(JSON.stringify(status === 200 ? { ok: true } : { error: "boom" }), { status });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    wrap(<PersonaModal />);
    await screen.findByText(/welcome to libi/i);

    fireEvent.click(screen.getByRole("button", { name: /solo creator/i }));
    await screen.findByText(/couldn.t save/i);
    expect(screen.getByRole("dialog")).toBeInTheDocument();

    status = 200;
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("is a modal dialog laid over the page it is mounted on, which stays rendered beneath it", async () => {
    vi.stubGlobal("fetch", stubStateFetch(true));
    wrap(
      <>
        <div data-testid="agents-tab">the Agents tab</div>
        <PersonaModal />
      </>,
    );
    const dialog = await screen.findByRole("dialog", { name: /welcome to libi/i });
    expect(dialog).toBeVisible();
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("agents-tab")).toBeInTheDocument();
  });

  it("keeps keyboard focus inside the question: Tab and Shift+Tab never reach the Agents tab behind it", async () => {
    vi.stubGlobal("fetch", stubStateFetch(true));
    wrap(
      <>
        <button type="button">Agents</button>
        <PersonaModal />
      </>,
    );
    const dialog = await screen.findByRole("dialog", { name: /welcome to libi/i });
    const behind = screen.getByText("Agents");
    // Opening the question moves focus into it.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    for (const shift of [false, true]) {
      for (let i = 0; i < 10; i += 1) {
        await pressTab(shift);
        expect(document.activeElement).not.toBe(behind);
        await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
      }
    }
  });

  it("can't be dismissed: Escape and a press outside it leave the question open, and the agent pick behind it out of reach", async () => {
    vi.stubGlobal("fetch", stubStateFetch(true));
    const pickAgent = vi.fn();
    wrap(
      <>
        <button type="button" onClick={pickAgent}>
          Claude Code
        </button>
        <PersonaModal />
      </>,
    );
    const dialog = await screen.findByRole("dialog", { name: /welcome to libi/i });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    const behind = screen.getByText("Claude Code");
    const stillOpen = async () => {
      // Give a close a chance to land before asserting it didn't.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      expect(screen.getByRole("dialog", { name: /welcome to libi/i })).toBeVisible();
      expect(dialog.contains(document.activeElement)).toBe(true);
      // Hidden from assistive tech and out of the keyboard's reach while the question is up.
      expect(screen.queryByRole("button", { name: "Claude Code" })).toBeNull();
      expect(document.activeElement).not.toBe(behind);
    };

    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "Escape", code: "Escape" });
    fireEvent.keyUp(document.activeElement as HTMLElement, { key: "Escape", code: "Escape" });
    await stillOpen();

    // A left-button press and release on the backdrop — the click base-ui treats as dismissal.
    const backdrop = screen.getByTestId("persona-modal-backdrop");
    for (const target of [backdrop, document.body]) {
      fireEvent.pointerDown(target, { button: 0, pointerType: "mouse" });
      fireEvent.mouseDown(target, { button: 0 });
      fireEvent.pointerUp(target, { button: 0, pointerType: "mouse" });
      fireEvent.mouseUp(target, { button: 0 });
      fireEvent.click(target, { button: 0 });
      await stillOpen();
    }
    // Nothing here actually dispatches a click through the backdrop onto the
    // button behind it — jsdom does no hit-testing and doesn't enforce `inert`,
    // so a click landing on `pickAgent` can't be simulated. What proves the pick
    // is out of reach is `stillOpen()`: the button is gone from the accessibility
    // tree and focus never lands on it.
  });

  it("after a pick, goes back to the page the question interrupted", async () => {
    window.history.replaceState(null, "", "/agents?tab=agents&returnTo=%2Feditor%3Fpiece%3Dp1");
    try {
      vi.stubGlobal("fetch", savingFetch());
      wrap(<PersonaModal />);
      await screen.findByText(/welcome to libi/i);
      fireEvent.click(screen.getByRole("button", { name: /developer/i }));
      await waitFor(() => expect(replace).toHaveBeenCalledWith("/editor?piece=p1"));
      expect(push).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("never follows a place to go back to that is off this app: it stays on the Agents tab", async () => {
    window.history.replaceState(null, "", "/agents?tab=agents&returnTo=https%3A%2F%2Fevil.example%2Feditor");
    try {
      vi.stubGlobal("fetch", savingFetch());
      wrap(<PersonaModal />);
      await screen.findByText(/welcome to libi/i);
      fireEvent.click(screen.getByRole("button", { name: /developer/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(replace).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("never follows a place to go back to that only reaches another site once its dot-segments are resolved", async () => {
    // `/.//evil.example/` resolves to `//evil.example/`, which a browser takes as another host.
    window.history.replaceState(null, "", "/agents?tab=agents&returnTo=%2F.%2F%2Fevil.example%2F");
    try {
      vi.stubGlobal("fetch", savingFetch());
      wrap(<PersonaModal />);
      await screen.findByText(/welcome to libi/i);
      fireEvent.click(screen.getByRole("button", { name: /developer/i }));
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(replace).not.toHaveBeenCalled();
      expect(push).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState(null, "", "/");
    }
  });

  it("has no skip, close, or restart-libi escape hatch", async () => {
    vi.stubGlobal("fetch", stubStateFetch(true));
    wrap(<PersonaModal />);
    await screen.findByText(/welcome to libi/i);

    expect(screen.queryByRole("button", { name: /skip/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("restart libi");
  });
});
