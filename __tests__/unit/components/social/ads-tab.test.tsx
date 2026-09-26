// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { SocialApiError, type SocialAdsResponse } from "@/lib/queries/social";

let adsData: SocialAdsResponse | undefined;
let adsLoading = false;
let adsError: unknown;
const adsRefetch = vi.fn();

vi.mock("@/lib/queries/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/social")>();
  return {
    ...actual,
    useSocialAds: () => ({ data: adsData, isLoading: adsLoading, error: adsError, refetch: adsRefetch }),
  };
});

// AskAgentButton pulls in the chat-dispatch stack (editor state context,
// a dialog) that has nothing to do with what this tab renders — stubbed so
// the test can assert on `kind` without wiring up that whole surface.
vi.mock("@/components/social/ask-agent-button", () => ({
  AskAgentButton: ({ kind, label }: { kind: string; label?: string }) => (
    <button data-testid={`ask-agent-${kind}`}>{label ?? "Ask the agent"}</button>
  ),
}));

import { AdsTab } from "@/components/social/social-page/ads-tab";

function adFixtures(): SocialAdsResponse {
  return {
    accounts: [{ id: "act_1", network: "metaads", name: "Nagel Labs Ads", currency: "USD", connected: true }],
    campaigns: [],
    ads: [
      {
        ad: {
          id: "ad_boost",
          network: "metaads",
          name: "Desk setup — reel boost",
          status: "active",
          campaignName: "Launch",
          adAccountId: "act_1",
          currency: "USD",
          previewUrl: "https://facebook.com/ads/preview/1",
          createdAt: "2026-09-10T00:00:00.000Z",
          metrics: { spend: 42.18, impressions: 18400, clicks: 391, ctr: 2.12 },
        },
        origin: "boosted",
        postId: "post_reel",
        pieceId: "piece_1",
        pieceName: "Desk setup",
      },
      {
        ad: {
          id: "ad_dark",
          network: "metaads",
          name: "Studio launch — dark post",
          status: "paused",
          campaignName: "Retarget",
          adAccountId: "act_1",
          currency: "USD",
          createdAt: "2026-09-12T00:00:00.000Z",
          metrics: { spend: 118.92, impressions: 54300 },
        },
        origin: "linked",
        pieceId: "piece_2",
        pieceName: "Studio launch",
      },
      {
        ad: { id: "ad_elsewhere", network: "metaads", name: "Made in Ads Manager", status: "active", campaignName: "Launch" },
        origin: "external",
      },
    ],
    unavailable: [],
  };
}

const rowNames = () => screen.getAllByTestId("ad-row").map((r) => r.getAttribute("data-ad-id"));

beforeEach(() => {
  adsData = adFixtures();
  adsLoading = false;
  adsError = undefined;
  adsRefetch.mockClear();
  window.localStorage.clear();
});

describe("AdsTab", () => {
  it("lists every ad in a table, with its figures in the account's currency and absent ones as a dash", () => {
    render(<AdsTab onOpen={vi.fn()} />);
    expect(screen.getByTestId("ads-table")).toBeInTheDocument();
    expect(rowNames()).toEqual(["ad_boost", "ad_dark", "ad_elsewhere"]);

    const [boost, , external] = screen.getAllByTestId("ad-row");
    expect(boost).toHaveTextContent("Meta Ads — Ad");
    expect(boost).toHaveTextContent("Boosted post · Launch");
    expect(within(boost).getByTestId("ad-metric-spend")).toHaveTextContent("$42.18");
    expect(within(boost).getByTestId("ad-metric-ctr")).toHaveTextContent("2.12%");
    // Never a zero for a figure the provider did not send.
    expect(within(boost).getByTestId("ad-metric-reach")).toHaveTextContent("—");
    expect(external).toHaveTextContent("Not from libi");
  });

  it("sorts by a figure column — biggest first, then flipped — with missing figures kept last", () => {
    render(<AdsTab onOpen={vi.fn()} />);
    fireEvent.click(screen.getByTestId("sort-spend"));
    expect(rowNames()).toEqual(["ad_dark", "ad_boost", "ad_elsewhere"]);
    fireEvent.click(screen.getByTestId("sort-spend"));
    expect(rowNames()).toEqual(["ad_boost", "ad_dark", "ad_elsewhere"]);
  });

  it("the network mark opens the ad on the network, and Piece lands on the post a boost boosts", () => {
    const onOpen = vi.fn();
    render(<AdsTab onOpen={onOpen} />);
    const [boost, dark, external] = screen.getAllByTestId("ad-row");

    expect(within(boost).getByRole("link", { name: "Open on Meta Ads" })).toHaveAttribute("href", "https://facebook.com/ads/preview/1");
    expect(within(boost).getByTestId("post-piece-link")).toHaveAttribute("href", "/editor?piece=piece_1&post=post_reel");
    // An ad that never was a post lands on itself.
    expect(within(dark).getByTestId("post-piece-link")).toHaveAttribute("href", "/editor?piece=piece_2&post=ad_dark");
    // Made outside libi: nothing to open in libi.
    expect(within(external).queryByTestId("post-piece-link")).toBeNull();

    fireEvent.click(within(boost).getByTestId("ad-action-post"));
    expect(onOpen).toHaveBeenCalledWith("post_reel");
  });

  it("searches, filters by status and campaign, and narrows to ads from a libi piece", () => {
    render(<AdsTab onOpen={vi.fn()} />);
    fireEvent.change(screen.getByTestId("list-search"), { target: { value: "studio" } });
    expect(rowNames()).toEqual(["ad_dark"]);
    fireEvent.change(screen.getByTestId("list-search"), { target: { value: "" } });

    fireEvent.click(screen.getByRole("button", { name: "paused" }));
    expect(rowNames()).toEqual(["ad_dark"]);
    fireEvent.click(screen.getByRole("button", { name: "paused" }));

    fireEvent.change(screen.getByLabelText("Campaign"), { target: { value: "Launch" } });
    expect(rowNames()).toEqual(["ad_boost", "ad_elsewhere"]);
    fireEvent.click(screen.getByLabelText("From a libi piece"));
    expect(rowNames()).toEqual(["ad_boost"]);
  });

  it("switches to a grid of cards and remembers it", () => {
    const { unmount } = render(<AdsTab onOpen={vi.fn()} />);
    fireEvent.click(screen.getByTestId("view-toggle-grid"));
    expect(screen.getByTestId("ads-grid")).toBeInTheDocument();
    expect(screen.queryByTestId("ads-table")).toBeNull();
    // Status once per card — not twice.
    expect(within(screen.getAllByTestId("ad-row")[0]).getAllByTestId("ad-status-chip")).toHaveLength(1);
    unmount();
    render(<AdsTab onOpen={vi.fn()} />);
    expect(screen.getByTestId("ads-grid")).toBeInTheDocument();
  });

  it("is read-only: no Pause/Resume button and no budget input anywhere", () => {
    render(<AdsTab onOpen={vi.fn()} />);
    // "paused" is a status FILTER chip; a control that pauses would be "Pause".
    expect(screen.queryByRole("button", { name: /^pause$/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^resume$/i })).toBeNull();
    expect(screen.queryByLabelText(/budget/i)).toBeNull();
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });

  it("shows the closed-action-list line and the Ask-the-agent entry point, once", () => {
    render(<AdsTab onOpen={vi.fn()} />);
    expect(
      screen.getByText("Every ad change, including pausing, goes through your agent, which will state the budget and wait for your yes."),
    ).toBeInTheDocument();
    expect(screen.getAllByTestId("ask-agent-ads")).toHaveLength(1);
    expect(screen.getByTestId("ask-agent-ads")).toHaveTextContent("Ask the agent to create an ad…");
  });

  it("shows the provider's own unavailable message whenever the list is non-empty, even alongside real ads", () => {
    adsData = {
      ...adFixtures(),
      unavailable: [{ accountId: "ig_1", message: "A connected Facebook account is required to manage Instagram ads." }],
    };
    render(<AdsTab onOpen={vi.fn()} />);
    expect(screen.getByText(/Zernio hasn't exposed ads for this account yet/)).toBeInTheDocument();
    expect(screen.getByText("A connected Facebook account is required to manage Instagram ads.")).toBeInTheDocument();
    // The real ads from OTHER accounts still render — this is not a fallback for an empty list.
    expect(screen.getAllByTestId("ad-row")).toHaveLength(3);
  });

  it("renders the unavailable state for a SCOPE gap, with the provider's words", () => {
    const message = "Error: [403] Your token does not include the ads resource group. (code: insufficient_permissions)";
    adsData = {
      accounts: [],
      campaigns: [],
      ads: [],
      unavailable: [{ accountId: "ig_1", message }, { accountId: "tt_1", message }],
    };
    render(<AdsTab onOpen={vi.fn()} />);
    expect(screen.getByTestId("ads-unavailable")).toBeInTheDocument();
    expect(screen.getAllByText(message)).toHaveLength(2);
    expect(screen.queryByTestId("ads-error")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ads-empty")).not.toBeInTheDocument();
  });

  it("shows a fully-empty state when there is nothing to read at all", () => {
    adsData = { accounts: [], campaigns: [], ads: [], unavailable: [] };
    render(<AdsTab onOpen={vi.fn()} />);
    expect(screen.getByText("No ad accounts connected yet.")).toBeInTheDocument();
  });

  it("a hard read failure (not a 429) shows a distinct error with Retry, never the empty state", () => {
    adsData = undefined;
    adsError = new SocialApiError(502, { error: "provider", message: "ad_accounts_list_ad_accounts answered in a format libi cannot read" });
    render(<AdsTab onOpen={vi.fn()} />);
    expect(screen.getByTestId("ads-error")).toHaveTextContent("Couldn't read ads from Zernio right now.");
    expect(screen.queryByText("No ad accounts connected yet.")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(adsRefetch).toHaveBeenCalledTimes(1);
  });
});
