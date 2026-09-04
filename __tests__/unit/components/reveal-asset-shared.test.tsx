// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// The one place the reveal action lives. It exists because the Assets grid
// shipped without a reveal item while the sidebar had one — each menu carried
// its own copy, so a new surface had to remember to duplicate it.

const revealFileById = vi.fn(async () => {});
const revealFile = vi.fn(async () => {});
vi.mock("@/lib/shell/client", () => ({
  revealFileById: (id: string) => revealFileById(id),
  revealFile: (p: string) => revealFile(p),
  revealLabel: (plat: string) =>
    plat === "win32" ? "Show in File Explorer" : "Reveal in Finder",
  getShellPlatform: () => shellPlatform.value,
}));
const shellPlatform = { value: "darwin" as string };

const trackEvent = vi.fn();
vi.mock("@/lib/analytics/client", () => ({
  trackEvent: (n: string, p?: Record<string, unknown>) => trackEvent(n, p),
}));

import { RevealMenuItem, useRevealAsset } from "@/components/shared/reveal-asset";

beforeEach(() => {
  revealFileById.mockClear();
  revealFile.mockClear();
  trackEvent.mockClear();
  shellPlatform.value = "darwin";
});

describe("RevealMenuItem", () => {
  it("reveals by id and reports the source it was given", () => {
    render(<RevealMenuItem fileId="f1" source="asset_grid" />);
    fireEvent.click(screen.getByTestId("reveal-menu-item"));

    expect(revealFileById).toHaveBeenCalledWith("f1");
    expect(trackEvent).toHaveBeenCalledWith("asset_revealed", { source: "asset_grid" });
  });

  it("closes the host menu before acting", () => {
    const order: string[] = [];
    const onAfter = vi.fn(() => order.push("closed"));
    revealFileById.mockImplementation(async () => {
      order.push("revealed");
    });

    render(<RevealMenuItem fileId="f1" source="context_menu" onAfter={onAfter} />);
    fireEvent.click(screen.getByTestId("reveal-menu-item"));

    expect(onAfter).toHaveBeenCalledTimes(1);
    // The menu must be gone before the reveal runs, or it lingers over the
    // file manager the reveal just opened.
    expect(order).toEqual(["closed", "revealed"]);
  });

  it("carries the platform-native wording and is keyboard/pointer affordant", () => {
    const { unmount } = render(<RevealMenuItem fileId="f1" source="context_menu" />);
    const btn = screen.getByTestId("reveal-menu-item");
    expect(btn.textContent).toContain("Reveal in Finder");
    // base-ui's Button does not set this, so every interactive element in this
    // repo has to opt in explicitly.
    expect(btn.className).toContain("cursor-pointer");
    unmount();

    shellPlatform.value = "win32";
    render(<RevealMenuItem fileId="f1" source="context_menu" />);
    expect(screen.getByTestId("reveal-menu-item").textContent).toContain(
      "Show in File Explorer",
    );
  });

  it("works with no onAfter supplied", () => {
    render(<RevealMenuItem fileId="f2" source="summary_tab" />);
    expect(() => fireEvent.click(screen.getByTestId("reveal-menu-item"))).not.toThrow();
    expect(revealFileById).toHaveBeenCalledWith("f2");
  });
});

describe("useRevealAsset", () => {
  function Probe({ source }: { source: "summary_tab" }) {
    const { revealByPath, revealById, label } = useRevealAsset(source);
    return (
      <div>
        <span data-testid="label">{label}</span>
        <button data-testid="by-path" onClick={() => revealByPath("/tmp/x/clip.mp4")} />
        <button data-testid="by-id" onClick={() => revealById("f9")} />
      </div>
    );
  }

  it("reveals by path without re-resolving it, and reports the source", () => {
    render(<Probe source="summary_tab" />);
    fireEvent.click(screen.getByTestId("by-path"));

    expect(revealFile).toHaveBeenCalledWith("/tmp/x/clip.mp4");
    // The Summary row already holds the path; it must not round-trip the
    // location route again just to reveal.
    expect(revealFileById).not.toHaveBeenCalled();
    expect(trackEvent).toHaveBeenCalledWith("asset_revealed", { source: "summary_tab" });
  });

  it("swallows a rejecting reveal rather than leaking an unhandled rejection", async () => {
    revealFile.mockImplementationOnce(async () => {
      throw new Error("server restarting");
    });
    render(<Probe source="summary_tab" />);

    expect(() => fireEvent.click(screen.getByTestId("by-path"))).not.toThrow();
    await waitFor(() => expect(revealFile).toHaveBeenCalled());
  });

  it("exposes the same label the menu row renders", () => {
    render(<Probe source="summary_tab" />);
    expect(screen.getByTestId("label").textContent).toBe("Reveal in Finder");
  });
});
