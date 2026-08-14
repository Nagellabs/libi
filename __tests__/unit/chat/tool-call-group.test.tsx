// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render as tlRender, screen, cleanup } from "@testing-library/react";
import type { ReactElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import ToolCallGroup, { type ToolCallEntry } from "@/components/chat/tool-call-group";

afterEach(cleanup);

// The stop button uses React Query, so every render needs a client in scope.
function render(ui: ReactElement) {
  const qc = new QueryClient();
  return tlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

function entry(over: {
  id: string;
  status?: "pending" | "running";
  runningAt?: number;
  jobId?: string;
  result?: { completedAt?: number; success?: boolean };
}): ToolCallEntry {
  return {
    call: {
      type: "tool-call",
      toolCallId: over.id,
      toolId: null,
      rawTitle: `Tool ${over.id}`,
      args: {},
      startedAt: 1_000,
      ...(over.status ? { status: over.status } : {}),
      ...(over.runningAt !== undefined ? { runningAt: over.runningAt } : {}),
      ...(over.jobId ? { jobId: over.jobId } : {}),
    },
    ...(over.result
      ? {
          result: {
            type: "tool-result",
            toolCallId: over.id,
            toolId: null,
            rawTitle: `Tool ${over.id}`,
            result: "ok",
            success: over.result.success ?? true,
            ...(over.result.completedAt !== undefined
              ? { completedAt: over.result.completedAt }
              : {}),
          },
        }
      : {}),
  } as ToolCallEntry;
}

describe("ToolCallGroup row states", () => {
  it("pending row shows no timer and no stop", () => {
    render(
      <ToolCallGroup
        entries={[entry({ id: "a", status: "pending" }), entry({ id: "b", status: "pending" })]}
        active
      />,
    );
    expect(screen.queryByText(/\(\d+s\)/)).toBeNull();
    expect(screen.queryByText("stop")).toBeNull();
  });

  it("running row with jobId shows a ticking timer and stop", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(50_000));
    render(
      <ToolCallGroup
        entries={[
          entry({ id: "a", status: "running", runningAt: 20_000, jobId: "job-1" }),
          entry({ id: "b", status: "pending" }),
        ]}
        active
      />,
    );
    // 50s − 20s = 30s elapsed, only ONE timer (the running row's + header).
    expect(screen.getAllByText("(30s)").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("stop")).toHaveLength(1);
    vi.useRealTimers();
  });

  it("done row shows duration = completedAt − runningAt", () => {
    render(
      <ToolCallGroup
        entries={[
          entry({
            id: "a",
            runningAt: 10_000,
            result: { completedAt: 14_000 },
          }),
          entry({ id: "b", result: {} }), // done but never observed running → no timer
        ]}
        active={false}
      />,
    );
    expect(screen.getByText("(4s)")).toBeInTheDocument();
    // Row b renders no elapsed text at all.
    expect(screen.getAllByText(/\(\d+s\)/)).toHaveLength(1);
  });
});
