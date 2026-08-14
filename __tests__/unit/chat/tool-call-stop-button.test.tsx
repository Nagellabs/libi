// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ToolCallStopButton from "@/components/chat/tool-call-stop-button";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderBtn() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ToolCallStopButton jobId="job-1" />
    </QueryClientProvider>,
  );
}

describe("ToolCallStopButton confirm countdown", () => {
  it("first click shows a visible countdown that reverts to 'stop'", () => {
    vi.useFakeTimers();
    renderBtn();
    fireEvent.click(screen.getByText("stop"));
    expect(screen.getByText(/click again to confirm \(3\)/)).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(1000));
    expect(screen.getByText(/click again to confirm \(2\)/)).toBeInTheDocument();
    act(() => void vi.advanceTimersByTime(2100));
    expect(screen.getByText("stop")).toBeInTheDocument();
  });
});
