// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";
import type { SocialAccount } from "@/lib/social/types";

let accountsData: SocialAccount[] | undefined;
let factsData: Record<string, unknown> = {};
const setKind = vi.fn();

vi.mock("@/lib/queries/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/social")>();
  return {
    ...actual,
    useSocialAccounts: () => ({ data: accountsData, isLoading: false }),
    useSocialStatus: () => ({
      data: { providerId: "zernio", catalog: [{ id: "zernio", name: "Zernio", dashboardUrl: "https://zernio.com/dashboard" }] },
    }),
  };
});

vi.mock("@/lib/queries/social-music", () => ({
  useSocialMusicFacts: () => ({ data: { facts: factsData } }),
  useSetTikTokKind: () => ({ mutate: setKind }),
}));

import { AccountsStrip } from "@/components/social/social-page/accounts-strip";

function account(id: string, platform: string, username: string): SocialAccount {
  return { id, platform: platform as SocialAccount["platform"], username, displayName: username, active: true };
}

describe("AccountsStrip", () => {
  beforeEach(() => {
    accountsData = undefined;
    factsData = {};
    setKind.mockClear();
  });

  it("names every connected platform, not just the two libi composes for", () => {
    // The bug this pins: the label was a two-way ternary, so a Facebook or
    // YouTube account the user connected at the provider read as "TikTok".
    accountsData = [
      account("ig1", "instagram", "nagellabs"),
      account("tt1", "tiktok", "nagellabs"),
      account("fb1", "facebook", "nagelpage"),
      account("x1", "twitter", "nagel"),
      account("yt1", "youtube", "nagelchannel"),
    ];
    render(<AccountsStrip />);
    const cards = screen.getAllByTestId("account-card");
    expect(cards.map((c) => c.textContent)).toEqual([
      expect.stringContaining("Instagram · Business"),
      expect.stringContaining("TikTok"),
      expect.stringContaining("Facebook"),
      expect.stringContaining("X"),
      expect.stringContaining("YouTube"),
    ]);
  });

  it("badges an account libi's own composer can't post to, and leaves the others alone", () => {
    accountsData = [account("ig1", "instagram", "nagellabs"), account("yt1", "youtube", "nagelchannel")];
    render(<AccountsStrip />);
    const [ig, yt] = screen.getAllByTestId("account-card");
    expect(within(ig).queryByTestId("agent-only-account")).toBeNull();
    expect(within(yt).getByTestId("agent-only-account")).toHaveTextContent("agent only");
  });

  it("shows each account's music facts and lets the user set the TikTok type", () => {
    accountsData = [account("tt1", "tiktok", "nagellabs"), account("ig1", "instagram", "nagellabs")];
    factsData = {
      tt1: { tiktokKind: { value: "business", source: "detected", checkedAt: "t" } },
      ig1: { instagramFacebookLogin: { value: false, source: "detected", checkedAt: "t" } },
    };
    render(<AccountsStrip />);
    expect(screen.getByTestId("account-music-tt1")).toHaveTextContent("TikTok · Business (detected)");
    // Says HOW: Zernio offers two connection methods, and only Facebook opens the catalog.
    expect(screen.getByTestId("account-music-ig1")).toHaveTextContent("Music needs Facebook Login — Reconnect at Zernio and choose Facebook");
    fireEvent.change(screen.getByTestId("tiktok-kind-tt1"), { target: { value: "personal" } });
    expect(setKind).toHaveBeenCalledWith({ accountId: "tt1", tiktokKind: "personal" });
  });
});
