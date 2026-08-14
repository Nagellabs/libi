// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import {
  ScriptEmpty,
  ScriptInProgress,
  ScriptFailed,
} from "@/components/editor/script-empty-state";

describe("ScriptEmpty", () => {
  it("renders the explainer and calls onGenerate when the button is clicked", () => {
    const onGenerate = vi.fn();
    render(<ScriptEmpty onGenerate={onGenerate} />);
    expect(screen.getByText(/hasn't been analyzed yet/i)).toBeInTheDocument();
    // The copy must explain what the analysis is and who consumes it.
    expect(screen.getByText(/video-understanding model/i)).toBeInTheDocument();
    expect(screen.getByText(/paid via fal\.ai credits/i)).toBeInTheDocument();
    act(() => { fireEvent.click(screen.getByRole("button", { name: /generate ai analysis/i })); });
    expect(onGenerate).toHaveBeenCalled();
  });
});

describe("ScriptInProgress", () => {
  it("renders Step X of Y when total > 0 and cancel button works", () => {
    const onCancel = vi.fn();
    render(<ScriptInProgress done={2} total={4} onCancel={onCancel} />);
    expect(screen.getByText(/generating ai analysis/i)).toBeInTheDocument();
    expect(screen.getByText(/step 2 of 4/i)).toBeInTheDocument();
    act(() => { fireEvent.click(screen.getByRole("button", { name: /cancel/i })); });
    expect(onCancel).toHaveBeenCalled();
  });

  it("falls back to 'Starting…' when no progress yet (done=0, total=0)", () => {
    render(<ScriptInProgress done={0} total={0} onCancel={() => {}} />);
    expect(screen.getByText(/starting/i)).toBeInTheDocument();
  });
});

describe("ScriptFailed", () => {
  it("renders the error message and retry/open-chat buttons", () => {
    const onRetry = vi.fn();
    const onOpenChat = vi.fn();
    render(
      <ScriptFailed
        error="fal HTTP 422 on …"
        onRetry={onRetry}
        onOpenChat={onOpenChat}
      />,
    );
    expect(screen.getByText(/ai analysis failed/i)).toBeInTheDocument();
    expect(screen.getByText(/fal http 422/i)).toBeInTheDocument();
    act(() => { fireEvent.click(screen.getByRole("button", { name: /retry/i })); });
    expect(onRetry).toHaveBeenCalled();
    act(() => { fireEvent.click(screen.getByRole("button", { name: /open chat/i })); });
    expect(onOpenChat).toHaveBeenCalled();
  });
});
