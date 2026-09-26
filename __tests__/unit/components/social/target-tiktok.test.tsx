// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { TikTokCreatorInfo, TikTokOptions } from "@/lib/social/types";

let fixture: TikTokCreatorInfo | undefined;
let loading = false;

vi.mock("@/lib/queries/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/social")>();
  return {
    ...actual,
    useTikTokCreatorInfo: () => ({ data: fixture, isLoading: loading, error: null }),
  };
});

import { TargetTikTok } from "@/components/social/composer/target-tiktok";

function info(over: Partial<TikTokCreatorInfo> = {}): TikTokCreatorInfo {
  return {
    accountId: "acct-tt",
    privacyLevels: ["PUBLIC_TO_EVERYONE"],
    maxVideoSeconds: 600,
    canPostMore: true,
    interactions: {
      // `allow_duet` defaults TRUE while `options.allowDuet` below is false:
      // with every default false, this fixture could not tell a component
      // that renders the OPTIONS from one that renders creator info.
      allow_comment: { enabled: true, required: true, default: false },
      allow_duet: { enabled: true, required: true, default: true },
      allow_stitch: { enabled: true, required: true, default: false },
    },
    ...over,
  };
}

const options: TikTokOptions = {
  privacyLevel: "PUBLIC_TO_EVERYONE",
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  commercialContentType: "none",
  madeWithAi: true,
  contentPreviewConfirmed: true,
  expressConsentGiven: true,
};

function renderTarget(over: Partial<React.ComponentProps<typeof TargetTikTok>> = {}) {
  return render(
    <TargetTikTok
      accountId="acct-tt"
      options={options}
      consent={{ preview: false, express: false }}
      onChange={vi.fn()}
      onConsentChange={vi.fn()}
      {...over}
    />,
  );
}

beforeEach(() => {
  fixture = info();
  loading = false;
});

describe("TargetTikTok — only what creator info returns", () => {
  it("renders one radio per returned privacy level and nothing else", () => {
    fixture = info({ privacyLevels: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] });
    renderTarget();
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(2);
    expect(screen.getByRole("radio", { name: "Public" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Only me" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Friends" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Followers" })).not.toBeInTheDocument();
  });

  it("shows a level the mapping does not know verbatim rather than dropping it", () => {
    fixture = info({ privacyLevels: ["SOMETHING_NEW"] });
    renderTarget();
    expect(screen.getByRole("radio", { name: "SOMETHING_NEW" })).toBeInTheDocument();
  });

  it("canPostMore false disables the target and says so in TikTok's own terms", () => {
    fixture = info({ canPostMore: false });
    renderTarget();
    expect(screen.getByText("TikTok says this account can't post more right now")).toBeInTheDocument();
    for (const r of screen.getAllByRole("radio")) expect(r).toBeDisabled();
    expect(screen.getByTestId("tiktok-consent-preview")).toBeDisabled();
    expect(screen.getByTestId("tiktok-consent-express")).toBeDisabled();
  });

  it("the three interaction settings render the OPTIONS, not creator info", () => {
    renderTarget();
    // The fixture's `allow_duet` default is TRUE and this target's option is
    // false: what shows is the option. Seeding those options FROM creator
    // info is the composer's job, and is tested there.
    for (const id of ["tiktok-allow_comment", "tiktok-allow_duet", "tiktok-allow_stitch"]) {
      expect(screen.getByTestId(id)).toHaveAttribute("aria-checked", "false");
    }
    // `required` means the FIELD must be sent, not that TikTok forces the
    // value — it used to render as "(required by TikTok)" beside an off
    // switch, which said the opposite of what was true.
    expect(screen.queryByText(/required by TikTok/)).toBeNull();
  });

  it("an interaction the account is not allowed is off and cannot be turned on", () => {
    fixture = info({
      interactions: {
        allow_comment: { enabled: true, required: true, default: false },
        allow_duet: { enabled: true, required: true, default: true },
        allow_stitch: { enabled: false, required: true, default: false },
      },
    });
    renderTarget({ options: { ...options, allowStitch: true } });
    const stitch = screen.getByTestId("tiktok-allow_stitch");
    // base-ui's Switch marks itself with `data-disabled`, not the attribute.
    expect(stitch).toHaveAttribute("data-disabled");
    // Even with the option set true, a forbidden interaction reads off: TikTok
    // would reject the post, so showing it as on would be a lie the user only
    // discovers at publish.
    expect(stitch).toHaveAttribute("aria-checked", "false");
    expect(screen.getByText("(not available on this account)")).toBeInTheDocument();
  });

  it("names the account's own duration cap when the export is longer than it", () => {
    fixture = info({ maxVideoSeconds: 20 });
    renderTarget({ durationSeconds: 34 });
    expect(screen.getByTestId("tiktok-too-long").textContent).toBe("TikTok caps this account at 0:20; this export is 0:34.");
  });

  /** QA 2026-09-21, finding 8: the wire names `content_preview_confirmed` and
   *  `express_consent_given` were printed at the user, under each checkbox, in
   *  a consent block. Both consents still exist and both are still required —
   *  what changed is that they are explained in words. */
  it("explains the two consents TikTok requires in words, never by their wire names", () => {
    renderTarget();
    expect(screen.queryByText("content_preview_confirmed")).not.toBeInTheDocument();
    expect(screen.queryByText("express_consent_given")).not.toBeInTheDocument();
    expect(screen.getByTestId("tiktok-consent-preview")).toBeInTheDocument();
    expect(screen.getByTestId("tiktok-consent-express")).toBeInTheDocument();
    expect(screen.getByText(/I have previewed this post/)).toBeInTheDocument();
    expect(screen.getByText(/Music Usage Confirmation/)).toBeInTheDocument();
    // Still says WHY it is being asked — that is the part TikTok requires.
    expect(screen.getByText(/TikTok requires this before anything is published from another app/)).toBeInTheDocument();
    expect(screen.getByText(/TikTok requires for a post made outside its own app/)).toBeInTheDocument();
  });

  it("shows a skeleton, not a spinner, while creator info loads", () => {
    fixture = undefined;
    loading = true;
    renderTarget();
    expect(screen.getByTestId("tiktok-creator-info-skeleton")).toBeInTheDocument();
    expect(screen.queryByRole("radio")).not.toBeInTheDocument();
  });
});
