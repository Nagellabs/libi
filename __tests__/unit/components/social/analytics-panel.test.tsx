// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PostAnalytics } from "@/lib/social/types";

const refetch = vi.fn();
let analytics: PostAnalytics | undefined;
let loading = false;

vi.mock("@/lib/queries/social", () => ({
  useSocialPostAnalytics: () => ({ data: analytics, isLoading: loading, isFetching: false, refetch }),
  useSocialAccounts: () => ({ data: [] }),
}));

vi.mock("@/hooks/agent/use-dispatch-to-agent", () => ({
  useDispatchToAgent: () => ({ open: false, setOpen: vi.fn(), prompt: "", send: vi.fn(), copy: vi.fn(), sending: false, openWith: vi.fn() }),
}));
vi.mock("@/components/agent/dispatch-to-agent-dialog", () => ({ DispatchToAgentDialog: () => null }));
vi.mock("@/lib/analytics/client", () => ({ trackEvent: vi.fn() }));

import { AnalyticsPanel } from "@/components/social/analytics-panel";

function ready(): PostAnalytics {
  return {
    postId: "post_1",
    syncStatus: "ready",
    lastUpdated: "2026-09-21T10:00:00.000Z",
    perTarget: [{ platform: "tiktok", views: 1200, likes: 40 }],
  } as PostAnalytics;
}

describe("AnalyticsPanel — the header's two controls", () => {
  beforeEach(() => {
    refetch.mockClear();
    loading = false;
    analytics = ready();
  });

  // Both used to be full-width buttons under every post's table — two extra
  // rows of chrome per post in a list of ten (QA 2026-09-21). They are the
  // same two actions, in the header, as icons that name themselves.
  it("renders Refresh and Ask-the-agent as named icon buttons in the header", () => {
    render(<AnalyticsPanel postId="post_1" />);
    const refresh = screen.getByTestId("analytics-refresh");
    expect(refresh).toHaveAccessibleName("Refresh analytics");
    // An icon button with no accessible name is unusable by a screen reader
    // and unhoverable by anyone who does not already know what it does.
    expect(screen.getByTestId("ask-agent-analytics")).toHaveAccessibleName("Ask the agent what this means");
    // Neither is a full-width row any more.
    expect(screen.queryByRole("button", { name: /^Refresh$/ })).toBeNull();

    fireEvent.click(refresh);
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the same header — and the same Refresh — while the provider is still syncing", () => {
    analytics = { ...ready(), syncStatus: "pending", perTarget: [] } as PostAnalytics;
    render(<AnalyticsPanel postId="post_1" />);
    expect(screen.getByText(/syncing at Zernio/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("analytics-refresh"));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
