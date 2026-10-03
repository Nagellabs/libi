// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import type { LinkedPost, SocialAnalyticsResponse } from "@/lib/queries/social";

let postsData: LinkedPost[];
let analytics: Map<string, { data?: SocialAnalyticsResponse; isLoading: boolean }>;
const analyticsIdsAsked: string[][] = [];

vi.mock("@/lib/queries/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/social")>();
  const mutation = () => ({ mutate: vi.fn(), isPending: false });
  return {
    ...actual,
    useSocialPosts: () => ({ data: { posts: postsData, page: 1, totalPages: 1 }, isLoading: false, error: null }),
    useSocialAccounts: () => ({ data: [] }),
    useSocialStatus: () => ({ data: { settings: { timezone: "UTC" } } }),
    useSocialPostsAnalytics: (ids: string[]) => {
      analyticsIdsAsked.push(ids);
      return analytics;
    },
    useRetrySocialPost: mutation,
    useSendToInbox: mutation,
    useUpdateSocialPost: mutation,
    useDeleteSocialPost: mutation,
  };
});
vi.mock("@/lib/analytics/client", () => ({ trackEvent: vi.fn() }));
vi.mock("@/components/social/ask-agent-button", () => ({
  AskAgentButton: ({ kind, label }: { kind: string; label?: string }) => <button data-testid={`ask-agent-${kind}`}>{label}</button>,
}));

import { PostsTab, postsEmptyCopy } from "@/components/social/social-page/posts-tab";

function post(over: Partial<LinkedPost> & { id: string }): LinkedPost {
  return {
    status: "published",
    content: "",
    createdAt: "2026-09-10T10:00:00.000Z",
    publishedAt: "2026-09-10T10:00:00.000Z",
    media: [],
    targets: [],
    tags: [],
    link: null,
    ...over,
  };
}

function ready(views: number, likes: number): SocialAnalyticsResponse {
  return { postId: "x", syncStatus: "ready", perTarget: [{ platform: "instagram", views, likes, comments: 1 }] };
}

beforeEach(() => {
  window.localStorage.clear();
  analyticsIdsAsked.length = 0;
  postsData = [
    post({
      id: "p_reel",
      content: "Desk setup reel",
      publishedAt: "2026-09-12T10:00:00.000Z",
      targets: [
        {
          platform: "instagram",
          accountId: "ig",
          status: "published",
          url: "https://instagram.com/p/1",
          options: { platform: "instagram", instagram: { contentType: "reel" } } as never,
        },
      ],
      libi: { pieceId: "piece_1", pieceName: "Desk setup" },
    }),
    post({
      id: "p_x",
      content: "One prompt in, a launch film out",
      publishedAt: "2026-09-11T10:00:00.000Z",
      targets: [{ platform: "twitter", accountId: "x", status: "published", url: "https://x.com/i/1" }],
    }),
    post({ id: "p_draft", status: "draft", content: "Not yet", targets: [{ platform: "tiktok", accountId: "tt", status: "pending" }] }),
  ];
  analytics = new Map([
    ["p_reel", { data: ready(900, 50), isLoading: false }],
    ["p_x", { data: ready(8900, 300), isLoading: false }],
  ]);
});

const rowIds = () => screen.getAllByTestId("post-row").map((r) => r.getAttribute("data-post-id"));

describe("PostsTab", () => {
  it("opens as a table with every post's numbers in columns, and asks analytics only for posts that are out", () => {
    render(<PostsTab onOpen={vi.fn()} />);
    expect(screen.getByTestId("posts-table")).toBeInTheDocument();
    const [reel, x, draft] = screen.getAllByTestId("post-row");
    expect(within(reel).getByTestId("post-row-kind")).toHaveTextContent("Instagram — Reel");
    expect(within(reel).getByTestId("metric-views")).toHaveTextContent("900");
    expect(within(x).getByTestId("metric-views")).toHaveTextContent("8.9k");
    // A draft has no numbers — and was never asked for any.
    expect(within(draft).getByTestId("metric-views")).toHaveTextContent("—");
    expect(analyticsIdsAsked.at(-1)).toEqual(["p_reel", "p_x"]);
  });

  it("sorts by any number column, biggest first, then flipped; posts with no number stay last", () => {
    render(<PostsTab onOpen={vi.fn()} />);
    fireEvent.click(screen.getByTestId("sort-views"));
    expect(rowIds()).toEqual(["p_x", "p_reel", "p_draft"]);
    fireEvent.click(screen.getByTestId("sort-views"));
    expect(rowIds()).toEqual(["p_reel", "p_x", "p_draft"]);
    fireEvent.click(screen.getByTestId("sort-likes"));
    expect(rowIds()).toEqual(["p_x", "p_reel", "p_draft"]);
  });

  it("the network mark opens the post there, and Piece opens the piece's Posting tab on this post", () => {
    render(<PostsTab onOpen={vi.fn()} />);
    const [reel, x] = screen.getAllByTestId("post-row");
    expect(within(reel).getByRole("link", { name: "Open on Instagram" })).toHaveAttribute("href", "https://instagram.com/p/1");
    expect(within(reel).queryByRole("link", { name: "Open" })).toBeNull();
    expect(within(reel).getByTestId("post-piece-link")).toHaveAttribute("href", "/editor?piece=piece_1&post=p_reel");
    // Made outside libi: no piece to go to.
    expect(within(x).queryByTestId("post-piece-link")).toBeNull();
  });

  it("searches the caption, the network and the piece", () => {
    render(<PostsTab onOpen={vi.fn()} />);
    fireEvent.change(screen.getByTestId("list-search"), { target: { value: "launch film" } });
    expect(rowIds()).toEqual(["p_x"]);
    fireEvent.change(screen.getByTestId("list-search"), { target: { value: "desk setup" } });
    expect(rowIds()).toEqual(["p_reel"]);
    fireEvent.change(screen.getByTestId("list-search"), { target: { value: "tiktok" } });
    expect(rowIds()).toEqual(["p_draft"]);
  });

  it("the grid shows each post once as a card: one status, no per-network chip repeating it", () => {
    render(<PostsTab onOpen={vi.fn()} />);
    fireEvent.click(screen.getByTestId("view-toggle-grid"));
    expect(screen.getByTestId("posts-grid")).toBeInTheDocument();
    const [reel] = screen.getAllByTestId("post-row");
    expect(within(reel).getAllByTestId("status-chip")).toHaveLength(1);
    expect(within(reel).queryAllByTestId("target-chip")).toHaveLength(0);
    expect(within(reel).getByTestId("post-grid-metrics")).toHaveTextContent("900 views");
  });

  it("opens the detail sheet from the caption", () => {
    const onOpen = vi.fn();
    render(<PostsTab onOpen={onOpen} />);
    fireEvent.click(screen.getByText("Desk setup reel"));
    expect(onOpen).toHaveBeenCalledWith("p_reel");
  });
});

describe("postsEmptyCopy", () => {
  it("says a post made directly at Zernio won't show, and counts them when it can", () => {
    expect(postsEmptyCopy(null)).toMatch(/^No posts made through libi yet\. A post made directly at Zernio won't show up/);
    expect(postsEmptyCopy(1)).toContain("Zernio shows 1 post made directly there");
    expect(postsEmptyCopy(3)).toContain("Zernio shows 3 posts made directly there");
  });
});
