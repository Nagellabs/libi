// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import type { ReactNode } from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { EffectsInspector } from "@/components/preview/effects-inspector";
import { createEffectHighlightStore } from "@/lib/preview/effect-highlight-store";

function wrap(ui: ReactNode) {
  const qc = new QueryClient();
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const baseProps = {
  pieceId: "p1",
  layerId: "t1",
  kind: "text" as const,
  effectHighlightStore: createEffectHighlightStore(),
  onOpenPicker: () => {},
  readOnly: false,
};

describe("EffectsInspector (empty-state + slot filtering)", () => {
  it("shows only the Effects button when no effects are applied", () => {
    wrap(<EffectsInspector {...baseProps} effects={undefined} />);
    expect(screen.getByTestId("inspector-effects")).toHaveTextContent("Effects");
    // No empty slot rows.
    expect(screen.queryByTestId("effect-slot-in")).not.toBeInTheDocument();
    expect(screen.queryByTestId("effect-slot-out")).not.toBeInTheDocument();
    expect(screen.queryByTestId("effect-slot-loop")).not.toBeInTheDocument();
  });

  it("renders only applied slots when effects exist", () => {
    wrap(<EffectsInspector {...baseProps} effects={{ in: { effectId: "fade" } }} />);
    expect(screen.getByTestId("effect-slot-in")).toBeInTheDocument();
    expect(screen.queryByTestId("effect-slot-out")).not.toBeInTheDocument();
    expect(screen.queryByTestId("effect-slot-loop")).not.toBeInTheDocument();
  });

  it("shows ALL animation phases at once (in + out + loop)", () => {
    wrap(
      <EffectsInspector
        {...baseProps}
        effects={{ in: { effectId: "fade" }, out: { effectId: "slide" }, loop: { effectId: "pulse" } }}
      />
    );
    expect(screen.getByTestId("effect-slot-in")).toBeInTheDocument();
    expect(screen.getByTestId("effect-slot-out")).toBeInTheDocument();
    expect(screen.getByTestId("effect-slot-loop")).toBeInTheDocument();
  });

  it("shows a reveal AND a box animation together (the reported bug)", () => {
    // A real fade-in occupies effects.in; the reveal is a separate field. Both
    // must appear — previously the reveal was invisible whenever effects.in was
    // occupied (no hydrate mirror slot to piggyback on).
    wrap(
      <EffectsInspector
        {...baseProps}
        effects={{ in: { effectId: "fade" } }}
        reveal={{ mode: "karaoke" }}
      />
    );
    expect(screen.getByTestId("effect-slot-reveal")).toHaveTextContent(/karaoke/i);
    expect(screen.getByTestId("effect-slot-in")).toBeInTheDocument(); // the fade
  });

  it("does NOT duplicate a reveal mirror as an in-slot (mirror filtered, reveal row shown)", () => {
    // effects.in carries the karaoke MIRROR (hydrate) + the reveal field. Show the
    // reveal row once; never a duplicate 'in' slot for the text-internal mirror.
    wrap(
      <EffectsInspector
        {...baseProps}
        effects={{ in: { effectId: "karaoke" } }}
        reveal={{ mode: "karaoke" }}
      />
    );
    expect(screen.getByTestId("effect-slot-reveal")).toBeInTheDocument();
    expect(screen.queryByTestId("effect-slot-in")).not.toBeInTheDocument();
  });

  it("no reveal row when reveal is absent or 'none'", () => {
    wrap(<EffectsInspector {...baseProps} effects={{ in: { effectId: "fade" } }} reveal={{ mode: "none" }} />);
    expect(screen.queryByTestId("effect-slot-reveal")).not.toBeInTheDocument();
    expect(screen.getByTestId("effect-slot-in")).toBeInTheDocument();
  });

  it("the reveal row has a Remove control (clears reveal, not the effect slot)", () => {
    wrap(<EffectsInspector {...baseProps} reveal={{ mode: "typewriter" }} effects={undefined} />);
    expect(screen.getByTestId("effect-slot-reveal")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove reveal/i })).toBeInTheDocument();
  });

  it("the reveal row shows a mode-faithful RevealThumbnail (not the generic pulse chip)", () => {
    // The karaoke row's thumb must be the real reveal animation, not a generic
    // opacity pulse. RevealThumbnail carries data-testid="reveal-thumbnail".
    wrap(<EffectsInspector {...baseProps} reveal={{ mode: "karaoke" }} effects={undefined} />);
    const row = screen.getByTestId("effect-slot-reveal");
    expect(row).toContainElement(screen.getByTestId("reveal-thumbnail"));
  });

  it("an animation row (slide out) does NOT render a RevealThumbnail (uses the animate() chip)", () => {
    wrap(<EffectsInspector {...baseProps} effects={{ out: { effectId: "slide" } }} />);
    expect(screen.getByTestId("effect-slot-out")).toBeInTheDocument();
    expect(screen.queryByTestId("reveal-thumbnail")).not.toBeInTheDocument();
  });
});

describe("EffectsInspector (disclosure rows)", () => {
  it("rows are collapsed by default — params hidden until the header is clicked", () => {
    wrap(<EffectsInspector {...baseProps} effects={{ out: { effectId: "slide", durationMs: 500 } }} />);
    expect(screen.queryByTestId("effect-out-duration")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("effect-row-toggle-out"));
    expect(screen.getByTestId("effect-out-duration")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("effect-row-toggle-out"));
    expect(screen.queryByTestId("effect-out-duration")).not.toBeInTheDocument();
  });

  it("multiple rows expand independently", () => {
    wrap(<EffectsInspector {...baseProps} effects={{ in: { effectId: "fade" }, out: { effectId: "slide" } }} />);
    fireEvent.click(screen.getByTestId("effect-row-toggle-in"));
    fireEvent.click(screen.getByTestId("effect-row-toggle-out"));
    expect(screen.getByTestId("effect-in-duration")).toBeInTheDocument();
    expect(screen.getByTestId("effect-out-duration")).toBeInTheDocument();
  });

  it("collapsed row shows a one-line summary (phase + duration)", () => {
    wrap(<EffectsInspector {...baseProps} effects={{ out: { effectId: "slide", durationMs: 500 } }} />);
    expect(screen.getByTestId("effect-slot-out")).toHaveTextContent(/out/);
    expect(screen.getByTestId("effect-slot-out")).toHaveTextContent(/500ms/);
  });

  it("clicking the reveal row asks the picker to open on the Reveal tab", () => {
    const onOpenPicker = vi.fn();
    wrap(<EffectsInspector {...baseProps} onOpenPicker={onOpenPicker} reveal={{ mode: "karaoke" }} effects={undefined} />);
    fireEvent.click(screen.getByTestId("effect-row-toggle-reveal"));
    expect(onOpenPicker).toHaveBeenCalledWith("reveal");
  });

  it("clicking × does not toggle/navigate (stopPropagation)", () => {
    const onOpenPicker = vi.fn();
    wrap(<EffectsInspector {...baseProps} onOpenPicker={onOpenPicker} reveal={{ mode: "karaoke" }} effects={undefined} />);
    fireEvent.click(screen.getByLabelText("Remove reveal"));
    expect(onOpenPicker).not.toHaveBeenCalled();
  });

  it("readOnly hides × and renders no chevron/expansion", () => {
    wrap(<EffectsInspector {...baseProps} readOnly effects={{ out: { effectId: "slide" } }} />);
    expect(screen.queryByLabelText(/clear out/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("effect-row-toggle-out"));
    expect(screen.queryByTestId("effect-out-duration")).not.toBeInTheDocument();
  });
});
