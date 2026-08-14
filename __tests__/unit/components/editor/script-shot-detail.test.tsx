// @vitest-environment jsdom
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ScriptShotDetail } from "@/components/editor/script-shot-detail";
import type { Shot } from "@/lib/analysis/types";

function shot(overrides: Partial<Shot> = {}): Shot {
  return {
    index: 0,
    start: 0,
    end: 5,
    description: "A wide shot of the city.",
    camera: { shot: "wide", angle: "eye-level", motion: "static" },
    lighting: "natural daylight",
    mood: "calm",
    action: "Cars drive by.",
    dialogue: "",
    transition_out: "cut",
    ...overrides,
  } as Shot;
}

describe("ScriptShotDetail", () => {
  it("renders description, camera/lighting/mood, action, transition", () => {
    render(<ScriptShotDetail shot={shot()} />);
    expect(screen.getByText("A wide shot of the city.")).toBeInTheDocument();
    // "wide" appears in both description and camera cell — use getAllByText
    expect(screen.getAllByText(/wide/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/natural daylight/i)).toBeInTheDocument();
    expect(screen.getByText(/calm/i)).toBeInTheDocument();
    expect(screen.getByText("Cars drive by.")).toBeInTheDocument();
    expect(screen.getByText(/cut/i)).toBeInTheDocument();
  });

  it("hides the Dialogue row when shot.dialogue is empty", () => {
    render(<ScriptShotDetail shot={shot({ dialogue: "" })} />);
    expect(screen.queryByText(/^dialogue$/i)).toBeNull();
  });

  it("shows the Dialogue row when shot.dialogue is non-empty", () => {
    render(<ScriptShotDetail shot={shot({ dialogue: "Hello there." })} />);
    expect(screen.getByText("Hello there.")).toBeInTheDocument();
  });

  it("shows shot index and time range in the header", () => {
    render(<ScriptShotDetail shot={shot({ index: 3, start: 12, end: 18 })} />);
    expect(screen.getByText(/shot 4/i)).toBeInTheDocument(); // 1-indexed in UI
    expect(screen.getByText(/0:12.*0:18/)).toBeInTheDocument();
  });
});
