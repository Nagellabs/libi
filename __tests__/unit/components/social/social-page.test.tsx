// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/analytics/client", () => ({ trackEvent: vi.fn() }));
vi.mock("@/lib/queries/providers", () => ({
  useProviders: () => ({ data: { connected: [] }, isLoading: false }),
}));
// AskAgentButton pulls in the whole chat-dispatch stack (editor state
// context, a dialog) — irrelevant to what SocialPage itself gates on.
vi.mock("@/components/social/ask-agent-button", () => ({
  AskAgentButton: ({ kind }: { kind: string }) => <button data-testid={`ask-agent-${kind}`}>Ask the agent</button>,
}));

// Same `router.replace` + pending-write pattern used by
// `use-social-page-params.test.ts` — SocialPage doesn't assert on the URL
// itself here, only that tab switches keep working through it.
let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => {
    const want = search ? `?${search}` : "";
    if (window.location.pathname !== "/social" || window.location.search !== want) {
      window.history.replaceState({}, "", `/social${want}`);
    }
    return { replace: vi.fn() };
  },
  usePathname: () => "/social",
  useSearchParams: () => new URLSearchParams(search),
}));

import { SocialPage } from "@/components/social/social-page/social-page";
import type { SocialStatusResponse, SocialAdsResponse } from "@/lib/queries/social";

const CATALOG = [{ id: "zernio", name: "Zernio", docsUrl: "https://docs.zernio.com", dashboardUrl: "https://zernio.com/dashboard" }];
const DEFAULT_SETTINGS = { timezone: "Asia/Bangkok", defaults: { instagramType: "reel" as const, aiLabel: true }, pollSeconds: 30 as const };

let statusFixture: SocialStatusResponse;
let accountsFixture: unknown[];
let postsShouldRateLimit: boolean;
let adsFixture: SocialAdsResponse;

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

beforeEach(() => {
  search = "";
  window.history.replaceState({}, "", "/social");
  postsShouldRateLimit = false;
  accountsFixture = [];
  adsFixture = { accounts: [], campaigns: [], ads: [], unavailable: [] };
  statusFixture = {
    providerId: "zernio",
    connected: true,
    needsReconnect: false,
    scopes: ["accounts:read", "posts:read", "posts:write", "analytics:read"],
    catalog: CATALOG,
    settings: { providerId: "zernio", ...DEFAULT_SETTINGS },
  };

  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const path = url.split("?")[0];
    if (path === "/api/social/status") return jsonResponse(statusFixture);
    if (path === "/api/social/accounts") return jsonResponse({ accounts: accountsFixture });
    if (path === "/api/social/posts") {
      if (postsShouldRateLimit) return jsonResponse({ error: "rate_limited", retryAt: "2026-09-20T12:34:00.000Z" }, 429);
      return jsonResponse({ posts: [], page: 1, totalPages: 1 });
    }
    if (path === "/api/social/ads") return jsonResponse(adsFixture);
    throw new Error(`unhandled fetch in test: ${url}`);
  }) as unknown as typeof fetch;
});

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SocialPage />
    </QueryClientProvider>,
  );
}

describe("SocialPage", () => {
  it("shows the inline provider picker and no tab content when no provider is chosen", async () => {
    statusFixture = {
      providerId: null,
      connected: false,
      needsReconnect: false,
      scopes: [],
      catalog: CATALOG,
      settings: { providerId: null, ...DEFAULT_SETTINGS },
    };
    renderPage();

    await screen.findByTestId("social-provider-picker");
    expect(screen.getByText("Pick a provider")).toBeInTheDocument();
    // libi's part is free; the provider's is not necessarily — said before signing up.
    expect(screen.getByTestId("social-provider-cost-note")).toHaveTextContent("libi charges nothing for this");
    expect(screen.getByTestId("social-provider-cost-note")).toHaveTextContent(/may bill you/);
    expect(screen.getAllByRole("radio")).toHaveLength(1);
    expect(screen.getByText("Zernio")).toBeInTheDocument();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("every data tab renders the 'never connected' empty state when libi has never connected", async () => {
    statusFixture = { ...statusFixture, connected: false, needsReconnect: false };
    renderPage();

    await screen.findByTestId("social-connect-libi");
    expect(screen.getByText("Connect libi to Zernio to see your posts here.")).toBeInTheDocument();

    for (const tab of ["posts", "schedule", "ads"]) {
      fireEvent.click(screen.getByRole("tab", { name: tab }));
      expect(await screen.findByTestId("social-connect-libi")).toBeInTheDocument();
      expect(screen.getByText("Connect libi to Zernio to see your posts here.")).toBeInTheDocument();
    }
  });

  it("shows the revoked variant when libi's grant needs reconnecting", async () => {
    statusFixture = { ...statusFixture, connected: false, needsReconnect: true };
    renderPage();

    await screen.findByTestId("social-connect-libi");
    expect(screen.getByText("libi's connection was revoked. Your agent's connection is unaffected.")).toBeInTheDocument();
  });

  it("connected: opens on Posts, and there is no Dashboard or Analytics tab any more", async () => {
    renderPage();

    expect(screen.getByRole("tab", { name: "posts" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "dashboard" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "analytics" })).toBeNull();
    // With no posts and no filter, the list says why it may still look empty.
    expect(await screen.findByTestId("posts-empty")).toHaveTextContent("No posts made through libi yet.");
  });

  it("an old ?tab=dashboard link lands on Posts rather than on nothing", () => {
    search = "tab=dashboard";
    renderPage();
    expect(screen.getByRole("tab", { name: "posts" })).toHaveAttribute("aria-selected", "true");
  });

  it("a 429 on /api/social/posts renders exactly one rate-limit banner", async () => {
    postsShouldRateLimit = true;
    renderPage();

    const banners = await screen.findAllByTestId("social-rate-limit-banner");
    expect(banners).toHaveLength(1);
    expect(banners[0]).toHaveTextContent("Provider rate limit reached (free plan: 60 requests/min). Retrying at");
    await waitFor(() => expect(screen.getAllByTestId("social-rate-limit-banner")).toHaveLength(1));
  });
});
