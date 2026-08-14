// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ScriptSoundDesign } from "@/components/editor/script-sound-design";

describe("ScriptSoundDesign", () => {
  it("returns null when the entries list is empty", () => {
    const { container } = render(<ScriptSoundDesign entries={[]} onSeek={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one row per entry with timestamp and description", () => {
    render(
      <ScriptSoundDesign
        entries={[
          { timestamp: 3.5, description: "Door slam" },
          { timestamp: 18, description: "Train horn" },
        ]}
        onSeek={() => {}}
      />,
    );
    expect(screen.getByText(/0:03/)).toBeInTheDocument();
    expect(screen.getByText(/Door slam/)).toBeInTheDocument();
    expect(screen.getByText(/0:18/)).toBeInTheDocument();
    expect(screen.getByText(/Train horn/)).toBeInTheDocument();
  });

  it("clicking a row calls onSeek with the timestamp", () => {
    const onSeek = vi.fn();
    render(
      <ScriptSoundDesign
        entries={[{ timestamp: 7, description: "Glass break" }]}
        onSeek={onSeek}
      />,
    );
    const row = screen.getByText("Glass break").closest("button")!;
    act(() => { fireEvent.click(row); });
    expect(onSeek).toHaveBeenCalledWith(7);
  });
});
