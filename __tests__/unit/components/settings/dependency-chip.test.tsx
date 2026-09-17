// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type React from "react";

// Render tooltip content inline so the copy is assertable without hovering
// (same pattern as app-sidebar-readiness.test.tsx).
vi.mock("@/components/ui/tooltip", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>;
  return {
    Tooltip: Pass,
    TooltipProvider: Pass,
    TooltipContent: Pass,
    TooltipTrigger: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  };
});

import { DependencyChip } from "@/components/settings/dependency-chip";

/**
 * Chromium (`libi-export`) is installed ON DEMAND — inside the first canvas
 * export — not by Category A. A review found the manual download the
 * def's copy promised ("or here") was unreachable: the chip rendered a
 * control only in the `failed` state, and the `pending` copy claimed the
 * download "will start automatically", which is false for an on-demand dep.
 * A dep whose def says `manualInstall: true` gets a Download button while
 * pending and a Re-download action once installed, both on the existing
 * retry-dep route. Deps without the flag keep the old chip exactly.
 */
describe("DependencyChip — on-demand (manualInstall) deps", () => {
  const base = { binary: "chromium", path: null, source: null } as const;

  it("pending: renders a Download button that fires onRetry, and stops promising an automatic download", () => {
    const onRetry = vi.fn();
    render(
      <DependencyChip
        {...base}
        installed={false}
        runtimeStatus="pending"
        manualInstall
        onRetry={onRetry}
      />,
    );
    const button = screen.getByRole("button", { name: /download chromium/i });
    expect(button).toHaveTextContent("Download");
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);

    // The tooltip tells the truth: this happens now, or on the first tool
    // call that needs it — never "automatically". No size and no named job:
    // the flag covers youtube-download's uv + yt-dlp as well as
    // libi-export's chromium, and each row's description states its own.
    expect(screen.queryByText(/will start automatically/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/canvas export/i)).not.toBeInTheDocument();
    // Both the badge and the button tooltips name the real trigger.
    expect(screen.getAllByText(/first tool call that needs it/i).length).toBeGreaterThan(0);
  });

  it("installed: renders a Re-download action that fires onRetry", () => {
    const onRetry = vi.fn();
    render(
      <DependencyChip
        {...base}
        installed
        path="/cache/chromium-1217/chrome"
        source="bundled"
        runtimeStatus="installed"
        manualInstall
        onRetry={onRetry}
      />,
    );
    const button = screen.getByRole("button", { name: /re-download chromium/i });
    expect(button).toHaveTextContent("Re-download");
    fireEvent.click(button);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/replaces the current chromium/i)).toBeInTheDocument();
    expect(screen.getByText(/fail to launch/i)).toBeInTheDocument();
  });

  it("failed: keeps the Retry button and offers nothing else", () => {
    const onRetry = vi.fn();
    render(
      <DependencyChip
        {...base}
        installed={false}
        runtimeStatus="failed"
        error="playwright install chromium exited 1"
        manualInstall
        onRetry={onRetry}
      />,
    );
    expect(screen.getByRole("button", { name: /retry chromium/i })).toHaveTextContent("Retry");
    expect(screen.queryByRole("button", { name: /^download/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /re-download/i })).not.toBeInTheDocument();
  });

  it("installing: no control while a download is in flight", () => {
    render(
      <DependencyChip
        {...base}
        installed={false}
        runtimeStatus="installing"
        bytesDownloaded={50_000_000}
        bytesTotal={173_000_000}
        manualInstall
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText("29%")).toBeInTheDocument();
  });

  it("a pending retry disables the Download button", () => {
    render(
      <DependencyChip
        {...base}
        installed={false}
        runtimeStatus="pending"
        manualInstall
        onRetry={vi.fn()}
        retryPending
      />,
    );
    expect(screen.getByRole("button", { name: /download chromium/i })).toBeDisabled();
  });

  it("without onRetry there is no control in any state", () => {
    const { unmount } = render(
      <DependencyChip {...base} installed={false} runtimeStatus="pending" manualInstall />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    unmount();
    render(
      <DependencyChip
        {...base}
        installed
        path="/x"
        source="bundled"
        runtimeStatus="installed"
        manualInstall
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});

describe("DependencyChip — Category A deps are unchanged", () => {
  it("pending without manualInstall keeps the automatic-download copy and no button", () => {
    render(
      <DependencyChip
        binary="ffmpeg"
        installed={false}
        path={null}
        source={null}
        runtimeStatus="pending"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByText(/will start automatically/i)).toBeInTheDocument();
  });

  it("installed without manualInstall renders no Re-download action", () => {
    render(
      <DependencyChip
        binary="ffmpeg"
        installed
        path="/bin/ffmpeg"
        source="bundled"
        runtimeStatus="installed"
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
