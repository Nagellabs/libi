// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SocialApiError, type LinkedPost } from "@/lib/queries/social";
import type { SocialAccount, SocialPost } from "@/lib/social/types";
import { PostActions } from "@/components/social/post-actions";

const updateMutate = vi.fn();
const deleteMutate = vi.fn();
const retryMutate = vi.fn();
const inboxMutate = vi.fn();

const accounts: SocialAccount[] = [
  { id: "acct-ig", platform: "instagram", username: "nagellabs", displayName: "Nagel Labs", active: true },
  { id: "acct-tt", platform: "tiktok", username: "nagellabs", displayName: "Nagel Labs", active: true },
];

vi.mock("@/lib/queries/social", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queries/social")>();
  return {
    ...actual,
    useSocialStatus: () => ({ data: { settings: { timezone: "Asia/Bangkok" } } }),
    useSocialAccounts: () => ({ data: accounts }),
    useUpdateSocialPost: () => ({ mutate: updateMutate, isPending: false }),
    useDeleteSocialPost: () => ({ mutate: deleteMutate, isPending: false }),
    useRetrySocialPost: () => ({ mutate: retryMutate, isPending: false }),
    useSendToInbox: () => ({ mutate: inboxMutate, isPending: false, error: null }),
  };
});

function basePost(overrides: Partial<SocialPost> = {}): LinkedPost {
  return {
    id: "post_1",
    status: "draft",
    content: "Hello world",
    createdAt: "2026-09-18T08:00:00.000Z",
    media: [],
    targets: [
      { platform: "instagram", accountId: "acct-ig", status: "pending" },
      { platform: "tiktok", accountId: "acct-tt", status: "pending" },
    ],
    tags: [],
    link: null,
    ...overrides,
  };
}

function buttonNames() {
  return screen.getAllByRole("button").map((b) => b.textContent);
}

describe("PostActions — the closed lifecycle list", () => {
  beforeEach(() => {
    updateMutate.mockReset();
    deleteMutate.mockReset();
    retryMutate.mockReset();
    inboxMutate.mockReset();
  });

  it("draft: exactly Schedule…, Publish now, Send to TikTok inbox, Edit, Delete", () => {
    render(<PostActions post={basePost({ status: "draft" })} onEdit={() => {}} />);
    expect(buttonNames()).toEqual(["Schedule…", "Publish now", "Send to TikTok inbox", "Edit", "Delete"]);
  });

  it("an Instagram-only draft has no inbox to send to, so no such button", () => {
    render(
      <PostActions post={basePost({ status: "draft", targets: [{ platform: "instagram", accountId: "acct-ig", status: "pending" }] })} onEdit={() => {}} />,
    );
    expect(buttonNames()).toEqual(["Schedule…", "Publish now", "Edit", "Delete"]);
  });

  it("scheduled: exactly Reschedule…, Remove from schedule, Edit", () => {
    render(<PostActions post={basePost({ status: "scheduled", scheduledFor: "2026-09-25T10:00:00.000Z", timezone: "Asia/Bangkok" })} onEdit={() => {}} />);
    // "Remove from schedule", not "Cancel": the wire mode is still `cancel`
    // (it sets `is_draft`), but beside a Delete button "Cancel" read as
    // "cancel the post" (QA 2026-09-21). The label has to say where the post
    // ends up — as a draft — because that is the whole point of the action.
    expect(buttonNames()).toEqual(["Reschedule…", "Remove from schedule", "Edit"]);
  });

  it("failed: Retry, Edit, Delete — a failed post may still be deleted, unlike a partial one", () => {
    render(<PostActions post={basePost({ status: "failed" })} onEdit={() => {}} />);
    expect(buttonNames()).toEqual(["Retry", "Edit", "Delete"]);
  });

  it("partial: exactly Retry, Edit", () => {
    render(<PostActions post={basePost({ status: "partial" })} onEdit={() => {}} />);
    expect(buttonNames()).toEqual(["Retry", "Edit"]);
  });

  it("published: no buttons at all — each network is a link drawn as its own mark, and there is no Unpublish anywhere", () => {
    render(
      <PostActions
        post={basePost({
          status: "published",
          targets: [
            { platform: "instagram", accountId: "acct-ig", status: "published", url: "https://instagram.com/p/1" },
            { platform: "tiktok", accountId: "acct-tt", status: "published", url: "https://tiktok.com/@x/video/1" },
          ],
        })}
      />,
    );
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.queryByText(/unpublish/i)).toBeNull();
    // Named by the network it leaves for — never a row of identical "Open"s.
    expect(screen.queryByRole("link", { name: "Open" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open on Instagram" })).toHaveAttribute("href", "https://instagram.com/p/1");
    expect(screen.getByRole("link", { name: "Open on TikTok" })).toHaveAttribute("href", "https://tiktok.com/@x/video/1");
    for (const link of screen.getAllByTestId("post-action-open")) {
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.querySelector("svg")).not.toBeNull();
    }
  });

  it("hideOpen leaves the network links to the caller", () => {
    render(
      <PostActions
        hideOpen
        post={basePost({
          status: "published",
          targets: [{ platform: "instagram", accountId: "acct-ig", status: "published", url: "https://instagram.com/p/1" }],
        })}
      />,
    );
    expect(screen.queryAllByTestId("post-action-open")).toHaveLength(0);
  });

  it("cancelled: exactly Schedule…, Edit, Delete", () => {
    render(<PostActions post={basePost({ status: "cancelled" })} onEdit={() => {}} />);
    expect(buttonNames()).toEqual(["Schedule…", "Edit", "Delete"]);
  });

  it("publishing: no actions at all — a post already in flight offers nothing to click", () => {
    render(<PostActions post={basePost({ status: "publishing" })} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("Publish now opens a confirm naming each target's account with no undo, then mode: now on confirm", () => {
    render(<PostActions post={basePost({ status: "draft" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    expect(screen.getByText(/Instagram @nagellabs/)).toBeInTheDocument();
    expect(screen.getByText(/no undo: delete it in the Instagram app afterwards/)).toBeInTheDocument();
    expect(screen.getByText(/TikTok @nagellabs/)).toBeInTheDocument();
    expect(screen.getByText(/public on this account, no undo/)).toBeInTheDocument();

    // The background trigger is made inert while the modal is open, so
    // exactly one "Publish now" button remains in the accessibility tree —
    // the one inside the confirm dialog.
    fireEvent.click(screen.getByRole("button", { name: "Publish now" }));
    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [args] = updateMutate.mock.calls[0];
    expect(args.id).toBe("post_1");
    expect(args.when).toEqual({ mode: "now" });
  });

  describe("Send to TikTok inbox", () => {
    const tiktokOptions = {
      platform: "tiktok" as const,
      tiktok: { privacyLevel: "SELF_ONLY", allowComment: false, allowDuet: false, allowStitch: false, commercialContentType: "none" as const, contentPreviewConfirmed: true, expressConsentGiven: true },
    };
    const tiktokDraft = (over: Partial<SocialPost> = {}) =>
      basePost({
        status: "draft",
        targets: [{ platform: "tiktok", accountId: "acct-tt", status: "pending" }],
        libi: { pieceId: "p1", mediaUrl: "https://m/temp/x.mp4", targetOptions: [tiktokOptions] },
        ...over,
      });

    it("on a TikTok-only draft libi made: confirm says nothing is posted, then the inbox mutation runs (not a publish)", () => {
      render(<PostActions post={tiktokDraft()} />);
      const button = screen.getByTestId("post-action-inbox");
      expect(button).toBeEnabled();
      fireEvent.click(button);
      expect(screen.getByText(/Nothing is posted/)).toBeInTheDocument();
      expect(screen.getByText(/open the TikTok app's notification to finish it there/)).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Send to TikTok inbox" }));
      expect(inboxMutate).toHaveBeenCalledTimes(1);
      expect(inboxMutate.mock.calls[0][0]).toEqual({ id: "post_1", requestId: expect.any(String) });
      expect(updateMutate).not.toHaveBeenCalled();
    });

    it("on a draft that also goes to Instagram it is disabled and says why", () => {
      render(
        <PostActions
          post={tiktokDraft({
            targets: [
              { platform: "instagram", accountId: "acct-ig", status: "pending" },
              { platform: "tiktok", accountId: "acct-tt", status: "pending" },
            ],
            libi: { pieceId: "p1", targetOptions: [{ platform: "instagram", instagram: { contentType: "reel" } }, tiktokOptions] },
          })}
        />,
      );
      expect(screen.getByTestId("post-action-inbox")).toBeDisabled();
      expect(screen.getByTestId("post-action-inbox-reason")).toHaveTextContent(/also goes to Instagram/);
    });

    it("on a draft libi holds no settings for it is disabled and says so", () => {
      render(<PostActions post={tiktokDraft({ libi: undefined })} />);
      expect(screen.getByTestId("post-action-inbox")).toBeDisabled();
      expect(screen.getByTestId("post-action-inbox-reason")).toHaveTextContent(/does not have this draft's settings/);
    });

    it("a published post offers no inbox action", () => {
      render(<PostActions post={tiktokDraft({ status: "published" })} />);
      expect(screen.queryByTestId("post-action-inbox")).toBeNull();
    });
  });

  it("Delete opens a confirm and calls the delete mutation with the post id", () => {
    render(<PostActions post={basePost({ status: "draft" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByText("Delete this draft at Zernio?")).toBeInTheDocument();
    expect(screen.getByText("The piece and its export stay.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(deleteMutate).toHaveBeenCalledWith("post_1", expect.anything());
  });

  it("Retry calls the retry mutation with the post id", () => {
    render(<PostActions post={basePost({ status: "failed" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryMutate).toHaveBeenCalledWith("post_1", expect.anything());
  });

  it("Edit calls the onEdit callback rather than rendering a caption form itself", () => {
    const onEdit = vi.fn();
    render(<PostActions post={basePost({ status: "draft" })} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(onEdit).toHaveBeenCalledTimes(1);
  });

  it("no onEdit, no Edit button — the Social page rendered one that silently did nothing", () => {
    // `post-row.tsx` renders `<PostActions compact />` with no handler. While
    // the button was wired to `onEdit?.()` every Edit on the Social page was
    // a click into the void, which reads as broken rather than unavailable.
    for (const status of ["draft", "scheduled", "failed", "partial", "cancelled"] as const) {
      const { unmount } = render(
        <PostActions post={basePost({ status, ...(status === "scheduled" ? { scheduledFor: "2030-01-01T02:00:00.000Z", timezone: "Asia/Kathmandu" } : {}) })} />,
      );
      expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
      expect(screen.queryByTestId("post-action-edit")).toBeNull();
      unmount();
    }
  });

  it("Schedule… dispatches update.mutate with mode: schedule carrying the picked date and timezone", async () => {
    render(<PostActions post={basePost({ status: "draft" })} />);
    fireEvent.click(screen.getByTestId("post-action-schedule"));

    // The popover renders through a portal, so it isn't a descendant of the
    // trigger — `findByTestId` waits for it to mount and searches the whole
    // document the way `screen` does.
    fireEvent.click(await screen.findByTestId("reschedule-custom"));
    while (screen.getByTestId("reschedule-month").textContent !== "January 2030") {
      fireEvent.click(screen.getByLabelText("Next month"));
    }
    fireEvent.click(screen.getByTestId("reschedule-day-2030-01-01"));
    fireEvent.click(screen.getByTestId("reschedule-hour-09"));
    fireEvent.click(screen.getByTestId("reschedule-minute-00"));
    const tzInput = screen.getByPlaceholderText("Timezone (e.g. Asia/Bangkok)");
    // Deliberately a different zone than the mocked default (Asia/Bangkok),
    // so this only passes if the field's own value is what gets sent.
    fireEvent.change(tzInput, { target: { value: "America/New_York" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [args, opts] = updateMutate.mock.calls[0];
    expect(args).toEqual({
      id: "post_1",
      requestId: expect.any(String),
      when: {
        mode: "schedule",
        // The BARE wall-clock string, exactly as typed — the one shape
        // measured against the live provider and the one the composer
        // sends. This used to be `new Date(v).toISOString()`, a `Z` instant
        // sent ALONGSIDE `timezone`, which is a second wire format nothing
        // has ever tested against Zernio.
        scheduledFor: "2030-01-01T09:00",
        timezone: "America/New_York",
      },
    });
    expect(opts).toEqual({ onError: expect.any(Function), onSuccess: expect.any(Function) });
  });

  /**
   * The reschedule popover reads the stored instant IN THE POST'S ZONE.
   *
   * It used to re-implement a browser-local `toDatetimeLocal` — the exact
   * version the composer's own helper carries a comment warning against — so
   * a user rescheduling under an "Asia/Kathmandu" label saw their own wall
   * clock, and saving it moved the schedule by the offset. Asia/Kathmandu is
   * +05:45: no test host is in it, so a browser-zone read cannot accidentally
   * produce the right answer on anyone's machine.
   */
  it("Reschedule… shows the post's own wall clock, and sends it back unchanged", async () => {
    render(
      <PostActions post={basePost({ status: "scheduled", scheduledFor: "2030-01-01T02:00:00.000Z", timezone: "Asia/Kathmandu" })} />,
    );
    fireEvent.click(screen.getByTestId("post-action-reschedule"));

    // 02:00 UTC is 07:45 in Kathmandu, and the picker says so in words.
    expect(await screen.findByTestId("reschedule-readback")).toHaveTextContent("Tue 1 Jan, 07:45");
    expect(screen.getByPlaceholderText("Timezone (e.g. Asia/Bangkok)")).toHaveValue("Asia/Kathmandu");

    // Nudge it an hour later and save: the same wall clock goes back out.
    fireEvent.click(screen.getByTestId("reschedule-custom"));
    fireEvent.click(screen.getByTestId("reschedule-hour-08"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [args] = updateMutate.mock.calls[0];
    expect(args.when).toEqual({ mode: "schedule", scheduledFor: "2030-01-01T08:45", timezone: "Asia/Kathmandu" });
  });

  it("Remove from schedule dispatches update.mutate with the bare cancel shape — no scheduledFor or timezone survive", () => {
    render(
      <PostActions
        post={basePost({ status: "scheduled", scheduledFor: "2026-09-25T10:00:00.000Z", timezone: "Asia/Bangkok" })}
      />,
    );
    fireEvent.click(screen.getByTestId("post-action-cancel"));

    expect(updateMutate).toHaveBeenCalledTimes(1);
    const [args] = updateMutate.mock.calls[0];
    expect(args).toEqual({ id: "post_1", requestId: expect.any(String), when: { mode: "cancel" } });
  });

  it("shows the rate-limit line with the provider's own retry moment when a mutation reports one", () => {
    const retryAt = "2026-09-20T15:30:00.000Z";
    updateMutate.mockImplementation((_payload, opts) => {
      opts?.onError?.(new SocialApiError(429, { error: "rate_limited", retryAt }));
    });
    render(
      <PostActions
        post={basePost({ status: "scheduled", scheduledFor: "2026-09-25T10:00:00.000Z", timezone: "Asia/Bangkok" })}
      />,
    );
    fireEvent.click(screen.getByTestId("post-action-cancel"));

    const expected = new Date(retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    // "try again after", not "retrying at": nothing in libi retries on a
    // timer, and the old wording promised a retry that never came.
    expect(screen.getByText(`Provider rate limit — try again after ${expected}`)).toBeInTheDocument();
  });

  it("never invents a retry moment — a mutation error with no retryAt renders no rate-limit line", () => {
    updateMutate.mockImplementation((_payload, opts) => {
      opts?.onError?.(new SocialApiError(429, { error: "rate_limited" })); // provider sent no retryAt
    });
    render(
      <PostActions
        post={basePost({ status: "scheduled", scheduledFor: "2026-09-25T10:00:00.000Z", timezone: "Asia/Bangkok" })}
      />,
    );
    fireEvent.click(screen.getByTestId("post-action-cancel"));

    expect(screen.queryByText(/Provider rate limit/)).toBeNull();
  });

  it("never invents a retry moment — a non-rate-limit error renders no rate-limit line either", () => {
    updateMutate.mockImplementation((_payload, opts) => {
      opts?.onError?.(new Error("network down"));
    });
    render(
      <PostActions
        post={basePost({ status: "scheduled", scheduledFor: "2026-09-25T10:00:00.000Z", timezone: "Asia/Bangkok" })}
      />,
    );
    fireEvent.click(screen.getByTestId("post-action-cancel"));

    expect(screen.queryByText(/Provider rate limit/)).toBeNull();
  });
});
