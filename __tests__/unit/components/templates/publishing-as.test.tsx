// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { PendingPublish } from "@/lib/templates/types";

const setMock = vi.fn();
const resetMock = vi.fn();
const discardMock = vi.fn();
let author: { data?: { nickname: string | null; authorId: string | null }; isError?: boolean; refetch?: () => void };
let mine: { data?: { nickname: string | null; templates: unknown[]; error?: string }; isPending: boolean };
let setState: { isPending: boolean; error: Error | null };
let pending: PendingPublish[] | undefined;
let discardState: { isPending: boolean; error: Error | null };

vi.mock("@/lib/queries/templates-cloud", () => ({
  useTemplatesAuthor: () => author,
  useCloudMine: () => mine,
  useSetNickname: () => ({ mutate: setMock, reset: resetMock, ...setState }),
  usePendingPublishes: () => ({ data: pending }),
  useDiscardPendingPublish: () => ({ mutate: discardMock, reset: vi.fn(), ...discardState }),
  useCreatorStatus: () => ({ data: { status: "approved" }, isPending: false }),
  useApplyAsCreator: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
}));
import { PublishingAs } from "@/components/templates/templates-page/publishing-as";

const row = (extra: Partial<PendingPublish>): PendingPublish => ({ templateId: "t1", name: "My hook", state: "unfinished", cloudId: "abcdefghijklmnopqrst", version: 1, detail: null, ...extra });

beforeEach(() => {
  author = { data: { nickname: "nadav", authorId: "a" } };
  mine = { data: { nickname: "nadav", templates: [] }, isPending: false };
  setState = { isPending: false, error: null };
  pending = [];
  discardState = { isPending: false, error: null };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function edit(value: string) {
  fireEvent.click(screen.getByRole("button", { name: "nadav" }));
  const input = screen.getByTestId("nickname-input");
  fireEvent.change(input, { target: { value } });
  return input;
}

describe("PublishingAs — nickname", () => {
  // A11 fix round 1: the site holds the nickname; a stale local copy must never invite overwriting it.
  it("shows the catalog's nickname over a stale local one, and a skeleton while neither has answered", () => {
    author = { data: { nickname: null, authorId: "a" } };
    mine = { data: undefined, isPending: true };
    const { rerender } = render(<PublishingAs />);
    expect(screen.getByTestId("publishing-as-skeleton")).toBeInTheDocument();
    mine = { data: { nickname: "site-nick", templates: [] }, isPending: false };
    rerender(<PublishingAs />);
    expect(screen.getByTestId("publishing-as-edit").textContent).toBe("site-nick");
    // Editing starts from the public name, not the stale local one.
    fireEvent.click(screen.getByTestId("publishing-as-edit"));
    expect((screen.getByTestId("nickname-input") as HTMLInputElement).value).toBe("site-nick");
    cleanup();
    // A local value renamed elsewhere: the site's wins.
    author = { data: { nickname: "old-local", authorId: "a" } };
    render(<PublishingAs />);
    expect(screen.getByTestId("publishing-as-edit").textContent).toBe("site-nick");
    cleanup();
    // Offline: the local value stands.
    mine = { data: { nickname: null, templates: [], error: "unreachable" }, isPending: false };
    render(<PublishingAs />);
    expect(screen.getByTestId("publishing-as-edit").textContent).toBe("old-local");
  });

  it("before the first publish the catalog has no nickname: the default one stored locally is shown, ready to edit", () => {
    author = { data: { nickname: "Brave Otter 4821", authorId: "a" } };
    mine = { data: { nickname: null, templates: [] }, isPending: false };
    render(<PublishingAs />);
    const edit = screen.getByTestId("publishing-as-edit");
    expect(edit).toHaveTextContent("Brave Otter 4821");
    expect(edit.className).toContain("cursor-pointer");
    fireEvent.click(edit);
    expect((screen.getByTestId("nickname-input") as HTMLInputElement).value).toBe("Brave Otter 4821");
  });

  it("shows the nickname and saves an inline edit on Enter, normalised", () => {
    render(<PublishingAs />);
    expect(screen.getByText("Publishing as")).toBeInTheDocument();
    fireEvent.keyDown(edit("  Nadav    N "), { key: "Enter" });
    expect(setMock).toHaveBeenCalledWith("Nadav N", expect.anything());
  });

  it("holds the value to the site's rule as the user types: an error, and nothing sent", () => {
    render(<PublishingAs />);
    for (const [value, message] of [
      ["x", /2 to 32 letters/],
      ["<x>", /2 to 32 letters/],
      ["--", /at least one letter or digit/],
      ["na‮dav", /direction-changing/],
      ["a".repeat(33), /2 to 32 letters/],
    ] as const) {
      cleanup();
      render(<PublishingAs />);
      const input = edit(value);
      expect(screen.getByTestId("nickname-error").textContent, value).toMatch(message);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByTestId("nickname-input")).toBeInTheDocument();
    }
    expect(setMock).not.toHaveBeenCalled();
  });

  it("an unchanged or emptied value, or Escape, closes without sending", () => {
    render(<PublishingAs />);
    fireEvent.keyDown(edit("nadav"), { key: "Enter" });
    fireEvent.keyDown(edit(""), { key: "Enter" });
    fireEvent.keyDown(edit("someone"), { key: "Escape" });
    expect(setMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("nickname-input")).toBeNull();
  });

  it("shows the route's refusal inline while editing", () => {
    setState = { isPending: false, error: new Error("The creator key changed while the nickname was being saved. Try again.") };
    render(<PublishingAs />);
    edit("fine");
    // Typing clears a stale refusal; the refusal of the NEXT attempt is shown.
    expect(resetMock).toHaveBeenCalled();
    expect(screen.getByTestId("nickname-error").textContent).toMatch(/creator key changed/);
  });

  it("a rename refused as creator_not_approved says why in rename words — never the publish refusal's 'Nothing was published.'", () => {
    setState = {
      isPending: false,
      error: Object.assign(new Error("Publishing is invite-only; apply on the Templates page (\"Apply to publish\"). Nothing was published."), { status: 403, code: "creator_not_approved" }),
    };
    render(<PublishingAs />);
    edit("fine");
    const shown = screen.getByTestId("nickname-error").textContent ?? "";
    expect(shown).toBe("You can't change your nickname: once you've published a template, only an approved creator can change it, even while your templates are hidden.");
    expect(shown).not.toMatch(/Nothing was published|hide your|in the catalog/i);
  });

  it("never offers an empty name to fill in: a skeleton until the nickname is read, and a retry when the read failed", () => {
    author = {};
    mine = { data: undefined, isPending: true };
    render(<PublishingAs />);
    expect(screen.getByTestId("publishing-as-skeleton")).toBeInTheDocument();
    expect(screen.queryByText("set a nickname")).toBeNull();
    cleanup();
    const refetch = vi.fn();
    author = { isError: true, refetch };
    mine = { data: { nickname: null, templates: [], error: "unreachable" }, isPending: false };
    render(<PublishingAs />);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refetch).toHaveBeenCalled();
    expect(screen.getByTestId("publishing-as-load-error")).toHaveTextContent(/Couldn.t load your nickname/);
    expect(screen.queryByTestId("publishing-as-edit")).toBeNull();
  });
});

describe("PublishingAs — pending publishes", () => {
  it("shows nothing when no publish is pending", () => {
    render(<PublishingAs />);
    expect(screen.queryByTestId("pending-publishes")).toBeNull();
  });

  it("words each state; a reserved id is not an alarm; discard asks first, then discards", () => {
    pending = [
      row({ templateId: "t-res", state: "reserved" }),
      row({ templateId: "t-att", state: "needs-attention", detail: "the catalog answered it with another version" }),
    ];
    render(<PublishingAs />);
    const reserved = screen.getByTestId("pending-publish-t-res");
    expect(reserved.textContent).toMatch(/Nothing in flight/);
    expect(reserved.textContent).not.toMatch(/stuck|error|failed/i);
    expect(screen.getByTestId("pending-publish-t-att").textContent).toMatch(/Why: the catalog answered it with another version/);

    const [firstDiscard] = screen.getAllByRole("button", { name: "Discard the pending publish" });
    fireEvent.click(firstDiscard);
    expect(discardMock).not.toHaveBeenCalled();
    expect(reserved.textContent).toMatch(/gets a new catalog id/);
    fireEvent.click(screen.getByTestId("pending-publish-discard-t-res"));
    expect(discardMock).toHaveBeenCalledWith("t-res", expect.anything());
  });

  it("a publish started against another catalog says so, with libi's words for what can be done", () => {
    pending = [row({ state: "other-catalog", detail: "Started against the test-mode catalog. The next publish of this template starts a new one here; discarding it forgets that one." })];
    render(<PublishingAs />);
    const text = screen.getByTestId("pending-publish-t1").textContent ?? "";
    expect(text).toMatch(/another catalog than the one this libi is using/);
    expect(text).toMatch(/Started against the test-mode catalog/);
    expect(screen.getByRole("button", { name: "Discard the pending publish" })).toBeInTheDocument();
  });

  it("a publish running now can't be discarded from here, and says why in plain sight", () => {
    pending = [row({ state: "publishing" })];
    render(<PublishingAs />);
    expect(screen.queryByRole("button", { name: "Discard the pending publish" })).toBeNull();
    expect(screen.getByTestId("pending-publish-t1").textContent).toMatch(/Stop the publish first to discard it/);
  });

  it("an unfinished publish's confirmation says libi checks the catalog first — never that it makes a second copy", () => {
    pending = [row({ state: "unfinished" })];
    render(<PublishingAs />);
    fireEvent.click(screen.getByRole("button", { name: "Discard the pending publish" }));
    const text = screen.getByTestId("pending-publish-t1").textContent ?? "";
    expect(text).toMatch(/libi checks the catalog first/);
    expect(text).not.toMatch(/second public copy, which you'd then hide/);
  });

  it("shows the route's refusal inline on the row", () => {
    pending = [row({ state: "unfinished" })];
    discardState = { isPending: false, error: new Error("This publish did reach the catalog. The next publish of this template finishes it — libi completes this same publish, not a second one.") };
    render(<PublishingAs />);
    expect(screen.getByTestId("pending-publish-error-t1").textContent).toMatch(/The next publish of this template finishes it/);
  });
});

describe("PublishingAs — the creator's approval", () => {
  it("shows the creator status line under the nickname", () => {
    render(<PublishingAs />);
    expect(screen.getByTestId("creator-status")).toHaveTextContent("Approved creator");
  });
});
