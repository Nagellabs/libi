// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import draft from "@/lib/social/providers/zernio/fixtures/post-draft.json";
import { toPost } from "@/lib/social/providers/zernio/normalize";
import type { LinkedPost } from "@/lib/queries/social";
import { PostRow } from "@/components/social/post-row";

// Overridable per test (reset in beforeEach) so a test can pin a display
// timezone distinct from both UTC and this machine's own local zone — the
// only way to prove PostRow actually threads the zone through rather than
// falling back to whatever zone happens to be ambient.
let displayTimezone = "Asia/Bangkok";

vi.mock("@/lib/queries/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/social")>();
  return {
    ...actual,
    useSocialStatus: () => ({ data: { settings: { timezone: displayTimezone } } }),
    useSocialAccounts: () => ({ data: [] }),
    useUpdateSocialPost: () => ({ mutate: vi.fn(), isPending: false }),
    useDeleteSocialPost: () => ({ mutate: vi.fn(), isPending: false }),
    useRetrySocialPost: () => ({ mutate: vi.fn(), isPending: false }),
    useSendToInbox: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  };
});

function linked(post: ReturnType<typeof toPost>): LinkedPost {
  return { ...post, link: null };
}

describe("PostRow", () => {
  beforeEach(() => {
    displayTimezone = "Asia/Bangkok";
  });

  it("a draft never shows a schedule", () => {
    const post = linked(toPost(draft));
    render(
      <ul>
        <PostRow post={post} onOpen={() => {}} />
      </ul>,
    );
    expect(screen.getByText("Draft")).toBeInTheDocument();
    expect(screen.queryByText(/Sep 21|11:00/)).toBeNull();
  });

  it("a cancelled post keeps its old scheduledFor (Zernio never clears it) but PostRow never renders it as a schedule", () => {
    // Ground truth verified live against Zernio 2026-09-20: a cancelled post
    // keeps its old `scheduledFor` on the post and on its platform rows —
    // unlike a draft, whose top-level `scheduledFor` normalize.ts strips.
    // Sanity-check that premise first, then prove PostRow doesn't fall into
    // the trap of rendering that stale value as if it were still scheduled.
    const cancelledRaw = { ...draft, status: "cancelled" };
    const post = linked(toPost(cancelledRaw));
    expect(post.scheduledFor).toBe("2026-09-21T11:00:00.000Z");

    render(
      <ul>
        <PostRow post={post} onOpen={() => {}} />
      </ul>,
    );
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.queryByText(/\d{1,2}:\d{2}/)).toBeNull();
    expect(screen.queryByText(/Sep 21/)).toBeNull();
  });

  it("a scheduled post renders the actual converted wall-clock time for its timezone, not the ambient one", () => {
    // Pinned to a zone (UTC-4 in September) distinct from BOTH UTC and this
    // suite's own default mocked zone (Asia/Bangkok, UTC+7) — so dropping the
    // timezone anywhere in the PostRow -> whenLabel chain lands on a visibly
    // different hour instead of accidentally matching by coincidence.
    displayTimezone = "America/New_York";
    const iso = "2026-09-21T11:00:00.000Z";
    const scheduled: LinkedPost = {
      ...linked(toPost(draft)),
      status: "scheduled",
      scheduledFor: iso,
      timezone: "America/New_York",
    };
    render(
      <ul>
        <PostRow post={scheduled} onOpen={() => {}} />
      </ul>,
    );
    expect(screen.getByText("Scheduled")).toBeInTheDocument();
    // Computed independently via the same Intl call `whenLabel` makes, with
    // an explicit (known-correct) timeZone — 11:00 UTC on 2026-09-21 is
    // 07:00 EDT, nowhere near Bangkok's 18:00 or UTC's own 11:00.
    const expected = new Intl.DateTimeFormat(undefined, {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "America/New_York",
    }).format(new Date(iso));
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it("renders one target chip per platform with its own status", () => {
    const post = linked(toPost(draft));
    render(
      <ul>
        <PostRow post={post} onOpen={() => {}} />
      </ul>,
    );
    const chips = screen.getAllByTestId("target-chip");
    expect(chips.map((c) => c.getAttribute("data-platform"))).toEqual(["instagram", "tiktok"]);
    expect(chips.every((c) => c.getAttribute("data-status") === "pending")).toBe(true);
  });

  it("a libi.pieceId renders a link to the REAL piece, not a bare /editor", () => {
    // QA finding 2: a bare `/editor` opened whatever piece happened to be
    // open last, not the piece this post was made from — even though
    // `post.libi.pieceId` (here "piece_1") was right there on the object.
    const post = linked(toPost(draft));
    render(
      <ul>
        <PostRow post={post} onOpen={() => {}} showPiece />
      </ul>,
    );
    const link = screen.getByRole("link", { name: post.libi!.pieceName! });
    expect(link).toHaveAttribute("href", `/editor?piece=${post.libi!.pieceId}`);
  });

  it("calls onOpen with the post id when the row is opened", () => {
    const post = linked(toPost(draft));
    const onOpen = vi.fn();
    render(
      <ul>
        <PostRow post={post} onOpen={onOpen} />
      </ul>,
    );
    screen.getByLabelText("Open post").click();
    expect(onOpen).toHaveBeenCalledWith(post.id);
  });
});
