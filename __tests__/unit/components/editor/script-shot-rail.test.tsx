// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ScriptShotRail } from "@/components/editor/script-shot-rail";
import type { Shot } from "@/lib/analysis/types";

// jsdom doesn't implement scrollIntoView — stub it.
beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

function shots(): Shot[] {
  return [
    { index: 0, start: 0, end: 5, description: "Wide opening shot of the city skyline at dawn." } as Shot,
    { index: 1, start: 5, end: 12, description: "Cut to interior, close-up on hands typing." } as Shot,
    { index: 2, start: 12, end: 18, description: "Pull back to reveal the room." } as Shot,
  ];
}

describe("ScriptShotRail", () => {
  it("renders every shot with index and time range", () => {
    render(
      <ScriptShotRail
        shots={shots()}
        selectedIdx={0}
        currentTime={0}
        onSelect={() => {}}
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText(/1 · 0:00.*0:05/)).toBeInTheDocument();
    expect(screen.getByText(/2 · 0:05.*0:12/)).toBeInTheDocument();
    expect(screen.getByText(/3 · 0:12.*0:18/)).toBeInTheDocument();
  });

  it("click calls onSelect and onSeek with the shot's start time", () => {
    const onSelect = vi.fn();
    const onSeek = vi.fn();
    render(
      <ScriptShotRail
        shots={shots()}
        selectedIdx={0}
        currentTime={0}
        onSelect={onSelect}
        onSeek={onSeek}
      />,
    );
    const row = screen.getByText(/2 · 0:05.*0:12/).closest("button")!;
    act(() => { fireEvent.click(row); });
    expect(onSelect).toHaveBeenCalledWith(1);
    expect(onSeek).toHaveBeenCalledWith(5);
  });

  it("renders the ▶ marker on the shot containing currentTime", () => {
    render(
      <ScriptShotRail
        shots={shots()}
        selectedIdx={0}
        currentTime={8}
        onSelect={() => {}}
        onSeek={() => {}}
      />,
    );
    const playingRow = screen.getByText(/2 · 0:05.*0:12/).closest("button")!;
    expect(playingRow.textContent).toMatch(/▶/);
  });
});
