// @vitest-environment jsdom
/**
 * `/api/jobs/:id/retry` refuses a `template_publish` job (only the user starts
 * one, by confirming on the Templates page — never from stored params), and a
 * Retry the route refuses would do nothing visible. The tab offers no Retry for
 * such a kind, and any other refused retry is toasted in the route's own words.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import "@testing-library/jest-dom/vitest";

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));
const retry = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false }));
const jobs = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/queries/jobs", () => ({
  useAllJobs: () => ({ data: { jobs: jobs.list }, isLoading: false, error: null }),
  useCancelJob: () => ({ mutate: vi.fn(), isPending: false }),
  useRetryJob: () => retry,
}));
import { toast } from "sonner";
import { JobsTab } from "@/components/settings/jobs-tab";
import { USER_STARTED_JOB_KINDS } from "@/lib/jobs/user-started-kinds";

const job = (id: string, kind: string, status: string) => ({
  id, kind, status, error: status === "failed" ? "boom" : null, progressDone: 0, progressTotal: 0, progressUnit: "steps", etaMs: null, startedAt: null,
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  jobs.list = [];
});

describe("Settings → Jobs retry", () => {
  it("the tab and the jobs routes read the same kinds, and a template publish is one", () => {
    const routes = ["app/api/jobs/route.ts", "app/api/jobs/[id]/retry/route.ts", "components/settings/jobs-tab.tsx"];
    for (const f of routes) expect(fs.readFileSync(path.resolve(f), "utf8"), f).toMatch(/from "@\/lib\/jobs\/user-started-kinds"/);
    expect(USER_STARTED_JOB_KINDS.has("template_publish")).toBe(true);
  });

  it("a failed or cancelled publish offers no Retry — it says to try again from Templates", () => {
    jobs.list = [job("p1", "template_publish", "failed"), job("p2", "template_publish", "cancelled")];
    render(<JobsTab />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    for (const id of ["p1", "p2"]) {
      const note = screen.getByTestId(`job-no-retry-${id}`);
      expect(note).toHaveTextContent("Try again from Templates");
      expect(note).toHaveAttribute("title", expect.stringMatching(/Templates page/));
    }
  });

  it("any other failed job keeps Retry, and a refused retry is toasted in the route's words", () => {
    jobs.list = [job("e1", "export_render", "failed")];
    render(<JobsTab />);
    expect(screen.queryByTestId("job-no-retry-e1")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry.mutate).toHaveBeenCalledWith("e1", expect.objectContaining({ onError: expect.any(Function) }));
    const { onError } = retry.mutate.mock.calls[0][1] as { onError: (e: Error) => void };
    onError(new Error("cannot retry job in status running"));
    expect(toast.error).toHaveBeenCalledWith("cannot retry job in status running");
  });

  it("useRetryJob rejects with the route's refusal, not a bare 'retry failed'", async () => {
    const real = await vi.importActual<typeof import("@/lib/queries/jobs")>("@/lib/queries/jobs");
    const refusal = "A template_publish job can't be retried from here. Ask the agent to run it again; it asks you first.";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: refusal }, { status: 403 })));
    try {
      const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
      const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
      const { result } = renderHook(() => real.useRetryJob(), { wrapper });
      result.current.mutate("p1");
      await waitFor(() => expect(result.current.error?.message).toBe(refusal));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Final review F7: an export queued behind another in the export lane.
  it("an export waiting for another export says so, not '0% (0/1 waiting)'", () => {
    jobs.list = [{ ...job("w1", "export", "running"), progressDone: 0, progressTotal: 1, progressUnit: "waiting" }];
    render(<JobsTab />);
    expect(screen.getByText("Waiting for another export to finish")).toBeInTheDocument();
    expect(screen.queryByText(/0%/)).toBeNull();
  });
});
