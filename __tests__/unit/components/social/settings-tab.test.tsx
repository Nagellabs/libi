// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SocialStatusResponse } from "@/lib/queries/social";

const disconnectMutate = vi.fn();
const connectMutate = vi.fn();
const reindexMutate = vi.fn();
const accountsRefetch = vi.fn();
const updateMutate = vi.fn();

let statusData: SocialStatusResponse | undefined;
let providersConnected: Array<{ agent: "claude" | "codex"; providerId: string | null; status: string }> = [];
let accountsData: unknown[] | undefined;
let accountsFetching = false;
let reindexData: { scanned: number; linked: number; orphans: string[]; truncated: boolean } | undefined;

vi.mock("@/lib/queries/providers", () => ({
  useProviders: () => ({ data: { connected: providersConnected }, isLoading: false }),
}));

vi.mock("@/lib/queries/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/social")>();
  return {
    ...actual,
    useSocialStatus: () => ({ data: statusData }),
    useDisconnectLibi: () => ({ mutate: disconnectMutate, isPending: false }),
    useConnectLibi: () => ({ mutateAsync: connectMutate, isPending: false }),
    useReindexLinks: () => ({ mutate: reindexMutate, data: reindexData, isPending: false }),
    useSocialAccounts: () => ({ data: accountsData, isFetching: accountsFetching, refetch: accountsRefetch }),
    useUpdateSocialSettings: () => ({ mutate: updateMutate, isPending: false }),
  };
});

import { SettingsTab } from "@/components/social/social-page/settings-tab";

function renderTab() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SettingsTab />
    </QueryClientProvider>,
  );
}

function baseStatus(): SocialStatusResponse {
  return {
    providerId: "zernio",
    connected: true,
    needsReconnect: false,
    scopes: ["accounts:read", "posts:read", "posts:write", "analytics:read"],
    connectedAt: "2026-09-01T00:00:00.000Z",
    lastVerifiedAt: "2026-09-20T09:00:00.000Z",
    tokenWhere: "file",
    catalog: [{ id: "zernio", name: "Zernio", docsUrl: "https://docs.zernio.com", dashboardUrl: "https://zernio.com/dashboard" }],
    settings: { providerId: "zernio", timezone: "Asia/Bangkok", defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 },
  };
}

beforeEach(() => {
  disconnectMutate.mockClear();
  connectMutate.mockReset();
  connectMutate.mockResolvedValue({ url: "https://zernio.com/oauth/authorize?x=1" });
  reindexMutate.mockClear();
  accountsRefetch.mockClear();
  updateMutate.mockClear();
  statusData = baseStatus();
  providersConnected = [{ agent: "claude", providerId: "zernio", status: "connected" }];
  accountsData = undefined;
  accountsFetching = false;
  reindexData = undefined;
});

describe("SettingsTab", () => {
  /** QA 2026-09-21, finding 11: while connected, Settings offered only Verify
   *  and Disconnect, so there was no way to redo a sign-in without throwing
   *  the working grant away first. */
  it("offers Reconnect while connected, and starting one changes nothing until it finishes", async () => {
    const open = vi.fn();
    vi.stubGlobal("open", open);
    try {
      renderTab();
      fireEvent.click(screen.getByTestId("social-reconnect"));
      expect(connectMutate).toHaveBeenCalledTimes(1);
      // The authorization URL is opened in the user's own browser; they
      // complete the sign-in there, exactly as the first Connect works.
      await waitFor(() => expect(open).toHaveBeenCalledWith("https://zernio.com/oauth/authorize?x=1", "_blank", "noopener"));
      // Not a destructive control: it does not disconnect on the way.
      expect(disconnectMutate).not.toHaveBeenCalled();
      expect(screen.getByText(/your current\s+connection keeps working until then/i)).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("renders the provider radio with Zernio selected", () => {
    renderTab();
    const radio = screen.getByRole("radio", { name: "Zernio" });
    expect(radio).toBeChecked();
  });

  it("shows one agent-connection row per agent: connected vs not added", () => {
    renderTab();

    const claudeRow = screen.getByTestId("agent-connection-row-claude-code");
    expect(claudeRow).toHaveTextContent("Connected");
    expect(within(claudeRow).getByRole("link", { name: "Manage on Providers" })).toHaveAttribute(
      "href",
      "/agents?tab=providers&provider=zernio&setupAgent=claude-code",
    );

    const codexRow = screen.getByTestId("agent-connection-row-codex");
    expect(codexRow).toHaveTextContent("Not added");
    expect(within(codexRow).getByRole("link", { name: "Add" })).toHaveAttribute(
      "href",
      "/agents?tab=providers&provider=zernio&setupAgent=codex",
    );

    expect(
      screen.getByText(/Your agent signs in to Zernio itself \(browser\)\..*libi never sees that sign-in\. New chats pick it up\./),
    ).toBeInTheDocument();
  });

  it("libi's connection: shows scopes, token location, and Verify reads accounts", () => {
    renderTab();
    const section = screen.getByTestId("libi-connection-section");
    expect(section).toHaveTextContent(/Connected as Zernio since/);
    for (const scope of statusData!.scopes) {
      expect(within(section).getByText(scope)).toBeInTheDocument();
    }
    expect(within(section).getByText("Kept in a private file in your libi home.")).toBeInTheDocument();

    fireEvent.click(within(section).getByRole("button", { name: "Verify" }));
    expect(accountsRefetch).toHaveBeenCalledTimes(1);
  });

  it("Verify shows the account count once read", () => {
    accountsData = [{ id: "a", platform: "instagram", username: "a" }, { id: "b", platform: "tiktok", username: "b" }];
    renderTab();
    expect(screen.getByText("2 accounts")).toBeInTheDocument();
  });

  it("lists the connected accounts, each as its own card — the Dashboard that held them is gone", () => {
    accountsData = [
      { id: "ig", platform: "instagram", username: "nagellabs", displayName: "Nagel Labs", active: true, health: { status: "healthy" } },
      { id: "tt", platform: "tiktok", username: "nagellabs", displayName: "Nagel Labs", active: true, health: { status: "healthy" } },
    ];
    renderTab();
    const section = screen.getByTestId("social-accounts-section");
    expect(within(section).getAllByTestId("account-card")).toHaveLength(2);
    expect(within(section).getAllByText("@nagellabs")).toHaveLength(2);
  });

  it("Disconnect opens a confirmation naming what stays, then calls the mutation", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Disconnect libi from Zernio?")).toBeInTheDocument();
    expect(screen.getByText(/Your agent's connection stays/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Zernio dashboard ↗" })).toHaveAttribute("href", "https://zernio.com/dashboard");

    // The confirm button, not the row's own trigger — Base UI's alert dialog
    // marks the rest of the page inert while open, so the trigger drops out
    // of the accessibility tree and `getByRole` (singular) uniquely finds
    // the dialog's own action button (same pattern as post-actions.test.tsx).
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(disconnectMutate).toHaveBeenCalledTimes(1);
  });

  it("shows a ConnectLibiEmptyState instead of the connection card when libi isn't connected", () => {
    statusData = { ...baseStatus(), connected: false, needsReconnect: false };
    renderTab();
    expect(screen.getByTestId("social-connect-libi")).toBeInTheDocument();
    expect(screen.queryByTestId("libi-connection-section")?.textContent).not.toMatch(/Connected as Zernio since/);
  });

  it("Defaults: timezone input, Instagram-type segmented control, AI-label switch", () => {
    renderTab();
    const defaults = screen.getByTestId("social-defaults");

    const timezoneInput = within(defaults).getByLabelText("Timezone") as HTMLInputElement;
    expect(timezoneInput.value).toBe("Asia/Bangkok");

    const reelButton = within(defaults).getByRole("button", { name: "Reel" });
    expect(reelButton).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(defaults).getByRole("button", { name: "Feed" }));
    expect(updateMutate).toHaveBeenCalledWith({
      providerId: "zernio",
      timezone: "Asia/Bangkok",
      defaults: { instagramType: "feed", aiLabel: true },
      pollSeconds: 30,
    });

    const aiSwitch = within(defaults).getByRole("switch");
    expect(aiSwitch).toHaveAttribute("aria-checked", "true");
    fireEvent.click(aiSwitch);
    expect(updateMutate).toHaveBeenCalledWith({
      providerId: "zernio",
      timezone: "Asia/Bangkok",
      defaults: { instagramType: "reel", aiLabel: false },
      pollSeconds: 30,
    });
  });

  it("Maintenance: Re-index calls the mutation and reports scanned/linked/orphans", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "Re-index posts from provider" }));
    expect(reindexMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Refresh while page is visible: every 30 s\./)).toBeInTheDocument();
  });

  it("shows the reindex result line once it lands", () => {
    reindexData = { scanned: 12, linked: 3, orphans: ["piece_x"], truncated: false };
    renderTab();
    expect(screen.getByTestId("reindex-result")).toHaveTextContent("Scanned 12 · linked 3 · 1 orphan");
  });

  it("never mentions 'make changes' or a read-only framing anywhere on the tab", () => {
    const { container } = renderTab();
    expect(container.textContent).not.toMatch(/make changes/i);
    expect(container.textContent).not.toMatch(/read-only/i);
  });
});
