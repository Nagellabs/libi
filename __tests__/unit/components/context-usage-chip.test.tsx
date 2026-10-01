// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ContextUsageChip from "@/components/chat/context-usage-chip";
import type { SessionUsageState } from "@/lib/sessions/usage";

/**
 * CW-1: the popover shows a Codex model's larger supported window
 * (`usage.maxSize`) beside the window Codex actually uses (`usage.size`),
 * while the ring/percentage stay pinned to used/size.
 */

let usage: SessionUsageState | null = null;

vi.mock("@/lib/queries/session-context", () => ({
  useSessionContext: () => ({ usage, commands: [] }),
}));
vi.mock("@/lib/queries/plan-usage", () => ({
  usePlanUsage: () => ({ data: undefined }),
}));
vi.mock("@/lib/editor-state-context", () => ({
  // codex, not claude-code: keeps the Claude-only PlanUsageSection out of
  // this test so it exercises only the maxSize line.
  useEditorState: () => ({ activeProviderId: "codex" }),
}));
vi.mock("@/lib/analytics/client", () => ({
  trackEvent: vi.fn(),
}));

function baseUsage(overrides: Partial<SessionUsageState> = {}): SessionUsageState {
  return {
    used: 120_000,
    size: 258_400,
    reportedSize: 258_400,
    cost: null,
    rateLimits: {},
    updatedAt: 0,
    maxSize: null,
    ...overrides,
  };
}

describe("ContextUsageChip — Codex max-window line (CW-1)", () => {
  it("with maxSize: shows the model-supports line, and the ring percent is still used/size", async () => {
    usage = baseUsage({ maxSize: 872_000 });
    render(<ContextUsageChip sessionId="s1" />);

    // 120_000 / 258_400 ≈ 46% — never used/max.
    expect(screen.getByText("46%")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Context usage" }));
    expect(
      await screen.findByText(/Model supports up to 872k/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Codex uses 258k unless you raise its context setting/),
    ).toBeInTheDocument();
  });

  it("without maxSize: no model-supports line", async () => {
    usage = baseUsage({ maxSize: null });
    render(<ContextUsageChip sessionId="s1" />);

    fireEvent.click(screen.getByRole("button", { name: "Context usage" }));
    await screen.findByText("Context");
    expect(screen.queryByText(/Model supports up to/)).toBeNull();
  });

  it("button title carries the max window when set, and omits it otherwise", () => {
    usage = baseUsage({ maxSize: 872_000 });
    const { rerender } = render(<ContextUsageChip sessionId="s1" />);
    expect(screen.getByRole("button", { name: "Context usage" })).toHaveAttribute(
      "title",
      "120k / 258k tokens (model supports up to 872k)",
    );

    usage = baseUsage({ maxSize: null });
    rerender(<ContextUsageChip sessionId="s1" />);
    expect(screen.getByRole("button", { name: "Context usage" })).toHaveAttribute(
      "title",
      "120k / 258k tokens",
    );
  });
});
