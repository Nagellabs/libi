// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ScriptOverviewStrip } from "@/components/editor/script-overview-strip";
import type { PersistedScript } from "@/lib/analysis/scripts";
import type { Script } from "@/lib/analysis/types";

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return (
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
  );
}

function persisted(overrides: Partial<Script> = {}): PersistedScript {
  return {
    step: {
      id: "s", fileId: "f", kind: "script:fal-video-understanding:gemini-2.5-pro",
      status: "ready", content: "{}", metadata: null, errorMessage: null,
      createdAt: new Date("2026-05-25T10:00:00Z"),
      updatedAt: new Date("2026-05-25T10:00:00Z"),
    } as never,
    script: {
      schema_version: "script_v1",
      duration: 30,
      overall_style: "Cinematic, warm tones.",
      pacing: "moderate",
      shots: [],
      music: { present: false },
      dialogue_summary: "",
      ...overrides,
    } as Script,
    providerId: "fal-video-understanding",
    modelId: "gemini-2.5-pro",
  };
}

Object.assign(navigator, {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
});

describe("ScriptOverviewStrip", () => {
  it("renders overall_style, pacing, and provider/model/date", () => {
    render(wrap(<ScriptOverviewStrip persisted={persisted()} onRegenerate={() => {}} onSeek={() => {}} />));
    expect(screen.getByText(/cinematic, warm tones/i)).toBeInTheDocument();
    expect(screen.getByText(/moderate/i)).toBeInTheDocument();
    // The pill renders the model + provider in a single friendly-labelled
    // element ("Gemini 2.5 Pro · fal.ai"), so we query the whole pill.
    expect(screen.getByText(/Gemini 2\.5 Pro · fal\.ai/)).toBeInTheDocument();
  });

  it("hides the music line when music.present is false", () => {
    render(wrap(<ScriptOverviewStrip persisted={persisted()} onRegenerate={() => {}} onSeek={() => {}} />));
    expect(screen.queryByText(/♫/)).toBeNull();
  });

  it("shows the music line when music.present is true", () => {
    render(wrap(
      <ScriptOverviewStrip
        persisted={persisted({
          music: { present: true, genre: "synthwave", tempo: "120bpm", instruments: ["synth"] } as never,
        })}
        onRegenerate={() => {}}
        onSeek={() => {}}
      />));
    expect(screen.getByText(/synthwave/)).toBeInTheDocument();
  });

  it("renders music cues as click-to-seek chips when present", () => {
    const onSeek = vi.fn();
    render(wrap(
      <ScriptOverviewStrip
        persisted={persisted({
          music: {
            present: true,
            genre: "ambient",
            cues: [
              { timestamp: 12, description: "drop" },
              { timestamp: 24, description: "build" },
            ],
          } as never,
        })}
        onRegenerate={() => {}}
        onSeek={onSeek}
      />));
    const chip = screen.getByRole("button", { name: /0:12/ });
    act(() => { fireEvent.click(chip); });
    expect(onSeek).toHaveBeenCalledWith(12);
  });

  it("hides dialogue_summary line when it's an empty string", () => {
    render(wrap(<ScriptOverviewStrip persisted={persisted()} onRegenerate={() => {}} onSeek={() => {}} />));
    expect(screen.queryByText(/🗩/)).toBeNull();
  });

  it("shows dialogue_summary line when non-empty (even no-op text)", () => {
    render(wrap(
      <ScriptOverviewStrip
        persisted={persisted({ dialogue_summary: "No dialogue is present in the video." })}
        onRegenerate={() => {}}
        onSeek={() => {}}
      />));
    expect(screen.getByText(/no dialogue is present/i)).toBeInTheDocument();
  });

  it("Copy JSON button copies the full script object", () => {
    render(wrap(<ScriptOverviewStrip persisted={persisted()} onRegenerate={() => {}} onSeek={() => {}} />));
    const btn = screen.getByRole("button", { name: /copy json/i });
    act(() => { fireEvent.click(btn); });
    expect(navigator.clipboard.writeText).toHaveBeenCalled();
    const payload = (navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(JSON.parse(payload as string).overall_style).toBe("Cinematic, warm tones.");
  });

  it("renders real cost (no estimated badge) when provider.costUsd is set and costEstimated is false", () => {
    render(wrap(
      <ScriptOverviewStrip
        persisted={persisted({
          provider: {
            name: "fal-video-understanding",
            model: "gemini-2.5-pro",
            generatedAt: "2026-05-25T10:00:00Z",
            costUsd: 0.0832,
            costEstimated: false,
          } as never,
        })}
        onRegenerate={() => {}}
        onSeek={() => {}}
      />));
    expect(screen.getByText(/\$0\.0832/)).toBeInTheDocument();
    expect(screen.queryByText(/^est$/i)).toBeNull();
  });

  it("renders the 'est' badge as a clickable button when costEstimated + requestId are set", () => {
    render(wrap(
      <ScriptOverviewStrip
        persisted={persisted({
          provider: {
            name: "fal-video-understanding",
            model: "gemini-2.5-pro",
            generatedAt: "2026-05-25T10:00:00Z",
            costUsd: 0.064,
            costEstimated: true,
            requestId: "req-1",
          } as never,
        })}
        onRegenerate={() => {}}
        onSeek={() => {}}
      />));
    expect(screen.getByText(/\$0\.0640/)).toBeInTheDocument();
    const est = screen.getByRole("button", { name: /Estimated cost/i });
    expect(est).toBeInTheDocument();
    expect(est).not.toBeDisabled();
    expect(est.textContent).toMatch(/^est$/i);
  });

  it("renders the 'est' badge as a static span (no button) when requestId is missing (legacy row)", () => {
    render(wrap(
      <ScriptOverviewStrip
        persisted={persisted({
          provider: {
            name: "fal-video-understanding",
            model: "gemini-2.5-pro",
            generatedAt: "2026-05-25T10:00:00Z",
            costUsd: 0.064,
            costEstimated: true,
            // No requestId — older row before refresh-cost support.
          } as never,
        })}
        onRegenerate={() => {}}
        onSeek={() => {}}
      />));
    expect(screen.queryByRole("button", { name: /Estimated cost/i })).toBeNull();
    const est = screen.getByText(/^est$/i);
    expect(est).toBeInTheDocument();
    expect(est.getAttribute("aria-label")).toMatch(/lookup unavailable/i);
  });

  it("renders the confirmed (real cost) chip with check icon when costEstimated is false", () => {
    render(wrap(
      <ScriptOverviewStrip
        persisted={persisted({
          provider: {
            name: "fal-video-understanding",
            model: "gemini-2.5-pro",
            generatedAt: "2026-05-25T10:00:00Z",
            costUsd: 0.0832,
            costEstimated: false,
            requestId: "req-1",
            costLastCheckedAt: "2026-05-25T10:05:00Z",
          } as never,
        })}
        onRegenerate={() => {}}
        onSeek={() => {}}
      />));
    expect(screen.getByText(/\$0\.0832/)).toBeInTheDocument();
    // The check chip is identified by its aria-label.
    expect(screen.getByLabelText(/Confirmed real cost/i)).toBeInTheDocument();
    // The clickable est button must NOT render in resolved state.
    expect(screen.queryByRole("button", { name: /Estimated cost/i })).toBeNull();
  });

  it("clicking the est badge POSTs to the refresh-cost endpoint with the right kind", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ status: "resolved", provider: { costUsd: 0.083 } }),
        { status: 200 },
      ),
    );
    render(wrap(
      <ScriptOverviewStrip
        persisted={persisted({
          provider: {
            name: "fal-video-understanding",
            model: "gemini-2.5-pro",
            generatedAt: "2026-05-25T10:00:00Z",
            costUsd: 0.064,
            costEstimated: true,
            requestId: "req-1",
          } as never,
        })}
        onRegenerate={() => {}}
        onSeek={() => {}}
      />));
    const est = screen.getByRole("button", { name: /Estimated cost/i });
    act(() => { fireEvent.click(est); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toMatch(/refresh-cost$/);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).kind).toBe(
      "script:fal-video-understanding:gemini-2.5-pro",
    );
  });

  it("on still_pending the chip stays as 'est' and the tooltip surfaces the just-checked message", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ status: "still_pending", provider: {} }),
        { status: 200 },
      ),
    );
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(wrap(
        <ScriptOverviewStrip
          persisted={persisted({
            provider: {
              name: "fal-video-understanding",
              model: "gemini-2.5-pro",
              generatedAt: "2026-05-25T10:00:00Z",
              costUsd: 0.064,
              costEstimated: true,
              requestId: "req-1",
            } as never,
          })}
          onRegenerate={() => {}}
          onSeek={() => {}}
        />));
      const est = screen.getByRole("button", { name: /Estimated cost/i });
      act(() => { fireEvent.click(est); });
      // Drive the 3 attempts (10s each between) to completion.
      await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      // The chip briefly shows "checked" text after settle.
      const btn = screen.getByRole("button", { name: /Estimated cost/i });
      expect(btn.textContent).toMatch(/checked/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits the cost segment when provider.costUsd is null/undefined", () => {
    render(wrap(
      <ScriptOverviewStrip
        persisted={persisted({
          provider: {
            name: "fal-video-understanding",
            model: "gemini-2.5-pro",
            generatedAt: "2026-05-25T10:00:00Z",
            costUsd: null,
            costEstimated: false,
          } as never,
        })}
        onRegenerate={() => {}}
        onSeek={() => {}}
      />));
    expect(screen.queryByText(/\$/)).toBeNull();
  });

  it("Regenerate button fires onRegenerate", () => {
    const onRegenerate = vi.fn();
    render(wrap(<ScriptOverviewStrip persisted={persisted()} onRegenerate={onRegenerate} onSeek={() => {}} />));
    // The "Regenerate" icon button is the second action button after Copy JSON.
    const btns = screen.getAllByRole("button");
    const regen = btns.find((b) => b.getAttribute("aria-label")?.match(/regenerate/i))!;
    act(() => { fireEvent.click(regen); });
    expect(onRegenerate).toHaveBeenCalled();
  });
});
