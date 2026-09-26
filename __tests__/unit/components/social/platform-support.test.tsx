// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { AgentOnlyTargets, PlatformSupport } from "@/components/social/platform-support";
import { isComposablePlatform, platformGlyph, platformLabel } from "@/lib/social/catalog";
import type { SocialAccount } from "@/lib/social/types";

function account(partial: Partial<SocialAccount> & Pick<SocialAccount, "platform">): SocialAccount {
  return { id: "a1", username: "nagellabs", displayName: "Nagel Labs", active: true, ...partial };
}

describe("platform naming", () => {
  it("names X by the provider's own key", () => {
    // Zernio's wire key for X is `twitter` — a row that arrives as `twitter`
    // must never render as "Twitter" or as the raw key.
    expect(platformLabel("twitter")).toBe("X");
    expect(platformGlyph("twitter")).toBe("X");
  });

  it("falls back to the raw key for a platform this build has never heard of", () => {
    expect(platformLabel("pinterest")).toBe("pinterest");
    expect(platformGlyph("pinterest")).toBe("PI");
  });

  it("marks only the two libi's own composer builds for", () => {
    expect(isComposablePlatform("instagram")).toBe(true);
    expect(isComposablePlatform("tiktok")).toBe(true);
    for (const p of ["facebook", "twitter", "youtube", "pinterest"]) {
      expect(isComposablePlatform(p)).toBe(false);
    }
  });
});

describe("PlatformSupport", () => {
  it("names all five platforms and says which ones libi posts to itself", () => {
    render(<PlatformSupport />);
    for (const [id, label] of [
      ["instagram", "Instagram"],
      ["tiktok", "TikTok"],
      ["facebook", "Facebook"],
      ["twitter", "X"],
      ["youtube", "YouTube"],
    ]) {
      // `textContent`, not a text query: X's label and its glyph are the
      // same single character, so a text match inside that row is ambiguous
      // by construction.
      expect(screen.getByTestId(`platform-support-${id}`).textContent).toContain(label);
    }
    expect(screen.getByTestId("platform-support-instagram")).toHaveAttribute("data-ui", "yes");
    expect(screen.getByTestId("platform-support-tiktok")).toHaveAttribute("data-ui", "yes");
    for (const id of ["facebook", "twitter", "youtube"]) {
      const row = screen.getByTestId(`platform-support-${id}`);
      expect(row).toHaveAttribute("data-ui", "no");
      // The promise the copy has to keep: the platform works TODAY, through
      // the agent — only libi's own composer is what's coming.
      expect(within(row).getByText(/Agent only · libi UI coming/)).toBeInTheDocument();
    }
  });
});

describe("AgentOnlyTargets", () => {
  it("renders nothing when every connected account is one the composer can build for", () => {
    const { container } = render(<AgentOnlyTargets accounts={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists an agent-only account by its real platform, with no way to select it", () => {
    render(<AgentOnlyTargets accounts={[account({ id: "fb1", platform: "facebook", username: "nagellabs" })]} />);
    const block = screen.getByTestId("agent-only-targets");
    expect(within(block).getByText("Facebook @nagellabs")).toBeInTheDocument();
    expect(within(block).queryByRole("checkbox")).toBeNull();
    expect(within(block).getByText(/Your agent posts to these through the provider's MCP today/)).toBeInTheDocument();
  });
});
