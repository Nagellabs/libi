// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

  it("has no skip, close, or restart-libi escape hatch", async () => {
    vi.stubGlobal("fetch", stubStateFetch(true));
    wrap(<PersonaModal />);
    await screen.findByText(/welcome to libi/i);

    expect(screen.queryByRole("button", { name: /skip/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /close/i })).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain("restart libi");
  });
});
