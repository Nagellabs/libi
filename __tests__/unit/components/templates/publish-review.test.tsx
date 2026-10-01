// @vitest-environment jsdom
//
// The review panel's states: only the user publishes, from here. The busy
// state is named on the button while the job runs; a failed attempt says why
// and offers a fresh confirm; a template changed since it was prepared can only
// be discarded; a new nickname is called out; the Terms link is §4A; the
// example and poster shown are the request's own — exactly what publishes.
// Publish arms only PUBLISH_ARM_DELAY_MS after a panel (or a new state of it)
// appears, and a request the agent prepared again over one the user was
// reading says so.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { PublishRequestView } from "@/lib/templates/types";

const confirmMock = vi.fn();
const discardMock = vi.fn();
let confirmState: { isPending: boolean; isSuccess: boolean };
let discardState: { isPending: boolean };
let requests: PublishRequestView[] = [];
let creator: { data?: { status: string | null; error?: string }; isPending: boolean };

// The catalog view (a dev build's catalog switch) is not under test here: the build's own site's links, no view.
const catalogView = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("@/lib/queries/templates-catalog", async () => {
  const { LEGAL_LINKS, legalLinksFor } = await import("@/lib/legal-links");
  const view = () => catalogView.current as { legalOrigin: string } | undefined;
  return { useLegalLinks: () => (view() ? legalLinksFor(view()!.legalOrigin) : LEGAL_LINKS), useTemplatesCatalog: () => ({ data: catalogView.current }) };
});
vi.mock("@/lib/queries/templates-cloud", () => ({
  CloudRouteError: class extends Error {},
  useConfirmPublishRequest: () => ({ mutate: confirmMock, ...confirmState }),
  useDiscardPublishRequest: () => ({ mutate: discardMock, ...discardState }),
  usePublishRequests: () => ({ data: requests }),
  useCreatorStatus: () => creator,
  useApplyAsCreator: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
}));
import { PUBLISH_ARM_DELAY_MS, PublishReviewPanel, PublishReviews, RIGHTS_HINT } from "@/components/templates/templates-page/publish-review";
import { OPENS_OUTSIDE_TEXT } from "@/components/templates/templates-page/opens-outside";
import { CloudRouteError } from "@/lib/queries/templates-cloud";
import { RIGHTS_CONFIRMATION_LABEL } from "@/lib/templates/cloud/constants";

const view = (over: Partial<PublishRequestView> = {}): PublishRequestView => ({
  id: "req-1",
  templateId: "t1",
  state: "awaiting",
  name: "Monday reset hook",
  description: "A Monday hook",
  tags: ["monday"],
  example: { kind: "file", fileId: "file-1", filename: "clip.mp4", pieceName: "Monday" },
  media: { videoUrl: "/api/templates/cloud/publish-requests/req-1/media/example.mp4", posterUrl: "/api/templates/cloud/publish-requests/req-1/media/poster.jpg", exampleBytes: 1000, posterBytes: 100 },
  nickname: { value: "nadav", isNew: false, replaces: null },
  publicItems: [{ label: "Your public nickname", detail: "nadav" }],
  republish: false,
  catalog: { kind: "production", origin: "https://libi.nagellabs.com", host: "libi.nagellabs.com" },
  error: null,
  confirmCode: "the-code",
  createdAt: 1,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  confirmState = { isPending: false, isSuccess: false };
  discardState = { isPending: false };
  requests = [];
  creator = { data: { status: "approved" }, isPending: false };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

/** Past the settle delay: the Publish button is live. */
const arm = () => act(() => vi.advanceTimersByTime(PUBLISH_ARM_DELAY_MS));

const publishButton = () => screen.getByTestId("publish-review-publish");
/** Tick (or untick) the rights box — in one panel's scope when several are shown. */
const tickRights = (scope: HTMLElement = document.body) => fireEvent.click(within(scope).getByTestId("publish-review-rights"));
const panelOf = (id: string) => screen.getByTestId(`publish-review-${id}`);
const discardButton = () => screen.getByTestId("publish-review-discard");
/** Can't be pressed: natively disabled, or focusable-disabled (busy, or settling) so focus stays put. */
const isOff = (el: HTMLElement) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
const expectOff = (el: HTMLElement) => expect(isOff(el), "the button can't be pressed").toBe(true);
const expectOn = (el: HTMLElement) => expect(isOff(el), "the button can be pressed").toBe(false);

describe("PublishReviewPanel", () => {
  it("awaiting: shows the example the catalog will use, what becomes public, the warning and §4A of the Terms; Publish sends the code", () => {
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    // The request's OWN example and poster, never the source file.
    expect(screen.getByTestId("publish-review-example")).toHaveAttribute("src", "/api/templates/cloud/publish-requests/req-1/media/example.mp4");
    expect(screen.getByTestId("publish-review-example")).toHaveAttribute("poster", "/api/templates/cloud/publish-requests/req-1/media/poster.jpg");
    expect(screen.getByTestId("publish-review-poster")).toHaveAttribute("src", "/api/templates/cloud/publish-requests/req-1/media/poster.jpg");
    expect(screen.getByTestId("publish-review-public-items")).toHaveTextContent("Your public nickname — nadav");
    expect(screen.getByTestId("publish-review-warning")).toHaveTextContent("Publishing makes this public. Anyone can install it; unpublishing doesn't recall copies already installed.");
    expect(screen.getByText(/By publishing you agree to the/)).toBeInTheDocument();
    expect(screen.getByTestId("publish-review-terms").getAttribute("href")).toMatch(/\/terms#templates-catalog$/);
    expect(screen.getByTestId("publish-review-terms")).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: `Terms ${OPENS_OUTSIDE_TEXT}` })).toBe(screen.getByTestId("publish-review-terms"));
    expect(publishButton()).toHaveTextContent("Publish publicly");
    expect(publishButton()).toHaveClass("cursor-pointer");
    expect(discardButton()).toHaveTextContent("Don't publish");
    arm();
    tickRights();
    fireEvent.click(publishButton());
    expect(confirmMock).toHaveBeenCalledWith({ id: "req-1", confirmCode: "the-code", rightsConfirmed: true }, expect.any(Object));
    fireEvent.click(discardButton());
    expect(discardMock).toHaveBeenCalledWith("req-1", expect.any(Object));
  });

  it("publishing: the wait is named on the button, and neither button can be pressed", () => {
    render(<PublishReviewPanel r={view({ state: "publishing", confirmCode: undefined })} highlighted={false} />);
    expect(publishButton()).toHaveTextContent("Publishing…");
    expect(publishButton()).toHaveAttribute("aria-disabled", "true");
    expectOff(discardButton());
    fireEvent.click(publishButton());
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it("a confirm in flight is busy too", () => {
    confirmState = { isPending: true, isSuccess: false };
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    expect(publishButton()).toHaveTextContent("Publishing…");
  });

  it("failed: says why, and offers a fresh confirm", () => {
    render(<PublishReviewPanel r={view({ state: "failed", error: "The catalog is paused.", confirmCode: "fresh" })} highlighted={false} />);
    expect(screen.getByTestId("publish-review-error")).toHaveTextContent("The last attempt didn't publish: The catalog is paused.");
    expect(publishButton()).toHaveTextContent("Try again: publish publicly");
    arm();
    tickRights();
    fireEvent.click(publishButton());
    expect(confirmMock).toHaveBeenCalledWith({ id: "req-1", confirmCode: "fresh", rightsConfirmed: true }, expect.any(Object));
  });

  it("changed: says the agent must prepare it again; only Don't publish is offered", () => {
    render(
      <PublishReviewPanel
        r={view({ state: "changed", confirmCode: undefined, error: "This template changed since it was prepared — ask the agent to prepare it again." })}
        highlighted={false}
      />,
    );
    expect(screen.getByTestId("publish-review-error")).toHaveTextContent("ask the agent to prepare it again");
    expectOff(publishButton());
    expectOn(discardButton());
  });

  it("no confirm code (a read that wasn't the page's own) can't publish", () => {
    render(<PublishReviewPanel r={view({ confirmCode: undefined })} highlighted={false} />);
    arm();
    expectOff(publishButton());
  });

  it("a new nickname is called out, with the one it replaces", () => {
    render(<PublishReviewPanel r={view({ nickname: { value: "New Name", isNew: true, replaces: "nadav" } })} highlighted={false} />);
    expect(screen.getByTestId("publish-review-nickname-note")).toHaveTextContent('Your nickname becomes "New Name" — it replaces "nadav" on every template you have published.');
  });

  it("every kind of example shows the request's own video and poster, and says where it was made from", () => {
    for (const [example, origin] of [
      [{ kind: "export", pieceId: "p1", pieceName: "Monday" }, 'Exported from the piece "Monday".'],
      [{ kind: "path", fileName: "take.mp4", path: "/x/take.mp4" }, "Made from take.mp4, a video on this computer."],
      [{ kind: "file", fileId: "file-1", filename: "clip.mp4", pieceName: "Monday" }, 'Made from clip.mp4 in "Monday".'],
    ] as const) {
      render(<PublishReviewPanel r={view({ example })} highlighted={false} />);
      expect(screen.getByTestId("publish-review-example").tagName).toBe("VIDEO");
      expect(screen.getByTestId("publish-review-example")).toHaveAttribute("src", "/api/templates/cloud/publish-requests/req-1/media/example.mp4");
      expect(screen.getByText(new RegExp(origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))).toBeInTheDocument();
      cleanup();
    }
  });

  it("media gone: says so instead of a player, and the request reads as changed", () => {
    render(<PublishReviewPanel r={view({ media: null, state: "changed", error: "The example video prepared for this publish is gone — ask the agent to prepare it again." })} highlighted={false} />);
    expect(screen.getByTestId("publish-review-example")).toHaveTextContent("The example video prepared for this publish is gone.");
    expect(screen.queryByTestId("publish-review-poster")).toBeNull();
    expectOff(publishButton());
  });
});

describe("the human gate settles before it can be clicked", () => {
  it("Publish is disabled for PUBLISH_ARM_DELAY_MS after a request appears", () => {
    expect(PUBLISH_ARM_DELAY_MS).toBe(1500);
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    tickRights();
    expectOff(publishButton());
    // Focusable while it settles: a keyboard user's focus doesn't drop to the page.
    expect(publishButton()).not.toHaveAttribute("disabled");
    expect(publishButton()).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(publishButton());
    expect(confirmMock).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(PUBLISH_ARM_DELAY_MS - 1));
    expectOff(publishButton());
    act(() => vi.advanceTimersByTime(1));
    expectOn(publishButton());
    // Don't publish is never held back.
    expectOn(discardButton());
  });

  it("a re-prepared request says so, announced", () => {
    render(<PublishReviewPanel r={view({ id: "req-2" })} highlighted={false} reprepared />);
    expect(screen.getByTestId("publish-review-reprepared")).toHaveTextContent(/prepared this again/i);
    expect(screen.getByTestId("publish-review-reprepared")).toHaveAttribute("role", "status");
  });

  it("a request that wasn't re-prepared says nothing of the kind", () => {
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    expect(screen.queryByTestId("publish-review-reprepared")).toBeNull();
  });

  it("a failed request re-arms after the delay too (Publish again)", () => {
    render(<PublishReviewPanel r={view({ state: "failed" })} highlighted={false} />);
    tickRights();
    expectOff(publishButton());
    arm();
    expectOn(publishButton());
  });

  it("a failure landing on an open panel disarms Publish until the delay passes again", () => {
    const { rerender } = render(<PublishReviewPanel r={view({ state: "publishing", confirmCode: undefined })} highlighted={false} />);
    arm();
    rerender(<PublishReviewPanel r={view({ state: "awaiting" })} highlighted={false} />);
    tickRights();
    rerender(<PublishReviewPanel r={view({ state: "failed", error: "The catalog is paused.", confirmCode: "fresh" })} highlighted={false} />);
    expectOff(publishButton());
    arm();
    expectOn(publishButton());
  });

  it("a failed request whose code rotated (another failed attempt) settles again", () => {
    const { rerender } = render(<PublishReviewPanel r={view({ state: "failed", error: "Paused.", confirmCode: "c1" })} highlighted={false} />);
    tickRights();
    arm();
    expectOn(publishButton());
    rerender(<PublishReviewPanel r={view({ state: "failed", error: "Paused.", confirmCode: "c2" })} highlighted={false} />);
    expectOff(publishButton());
    arm();
    expectOn(publishButton());
  });

  it("a stale-code refusal keeps the last attempt's reason visible beside it", () => {
    confirmMock.mockImplementationOnce((_v: unknown, opts: { onError: (e: Error) => void }) => opts.onError(new CloudRouteError("This review is out of date.", 403, "bad_confirm_code")));
    render(<PublishReviewPanel r={view({ state: "failed", error: "The catalog is paused.", confirmCode: "c1" })} highlighted={false} />);
    arm();
    tickRights();
    fireEvent.click(publishButton());
    const text = screen.getByTestId("publish-review-error").textContent ?? "";
    expect(text).toContain("This review is out of date.");
    expect(text).toContain("The last attempt didn't publish: The catalog is paused.");
  });
});

describe("PublishReviews", () => {
  it("a re-prepare moves the other reviews, so each of them settles again too", () => {
    requests = [view({ id: "req-a", templateId: "t1" }), view({ id: "req-b", templateId: "t2" })];
    const { rerender } = render(<PublishReviews highlightId={null} />);
    tickRights(panelOf("req-b"));
    arm();
    const b = () => within(screen.getByTestId("publish-review-req-b")).getByTestId("publish-review-publish");
    expectOn(b());

    // t1 is prepared again: its new request sorts last (oldest first), and B slides up into A's place.
    requests = [view({ id: "req-b", templateId: "t2" }), view({ id: "req-a2", templateId: "t1" })];
    rerender(<PublishReviews highlightId={null} />);
    expectOff(b());
    fireEvent.click(b());
    expect(confirmMock).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(PUBLISH_ARM_DELAY_MS - 1));
    expectOff(b());
    act(() => vi.advanceTimersByTime(1));
    expectOn(b());
  });

  it("a later render of the same list keeps every armed panel armed", () => {
    requests = [view({ id: "req-a", templateId: "t1" }), view({ id: "req-b", templateId: "t2" })];
    const { rerender } = render(<PublishReviews highlightId={null} />);
    for (const id of ["req-a", "req-b"]) tickRights(panelOf(id));
    arm();
    requests = [view({ id: "req-a", templateId: "t1" }), view({ id: "req-b", templateId: "t2" })];
    rerender(<PublishReviews highlightId="some-other-request" />);
    for (const id of ["req-a", "req-b"]) expectOn(within(screen.getByTestId(`publish-review-${id}`)).getByTestId("publish-review-publish"));
  });

  it("marks a request whose template had a different request before, and arms it afresh", () => {
    requests = [view({ id: "req-1" })];
    const { rerender } = render(<PublishReviews highlightId={null} />);
    expect(screen.queryByTestId("publish-review-reprepared")).toBeNull();
    tickRights();
    arm();
    expectOn(publishButton());

    // The agent prepares it again while the user reads: a new id, swapped in place.
    requests = [view({ id: "req-2", confirmCode: "new-code" })];
    rerender(<PublishReviews highlightId={null} />);
    expect(screen.getByTestId("publish-review-req-2")).toBeInTheDocument();
    expect(screen.getByTestId("publish-review-reprepared")).toHaveTextContent("The agent prepared this again. Look it over before you publish.");
    expectOff(publishButton());
    // The tick was for the request the user read, not this one.
    expect(screen.getByRole("checkbox", { name: RIGHTS_CONFIRMATION_LABEL })).not.toBeChecked();
    arm();
    expectOff(publishButton());
    tickRights();
    expectOn(publishButton());

    // Still says so on a later render of the same request (a refetch, a new highlight).
    requests = [view({ id: "req-2", confirmCode: "new-code" })];
    rerender(<PublishReviews highlightId="some-other-request" />);
    expect(screen.getByTestId("publish-review-reprepared")).toBeInTheDocument();
  });

  it("another template's request, or the first one the page sees, is not marked", () => {
    requests = [view({ id: "req-1", templateId: "t1" })];
    const { rerender } = render(<PublishReviews highlightId={null} />);
    requests = [view({ id: "req-1", templateId: "t1" }), view({ id: "req-9", templateId: "t2" })];
    rerender(<PublishReviews highlightId={null} />);
    expect(screen.queryByTestId("publish-review-reprepared")).toBeNull();
  });

  it("a new request after the earlier one was published or discarded is a fresh prepare, not a re-prepare", () => {
    requests = [view({ id: "req-1" })];
    const { rerender } = render(<PublishReviews highlightId={null} />);
    requests = [];
    rerender(<PublishReviews highlightId={null} />);
    requests = [view({ id: "req-2" })];
    rerender(<PublishReviews highlightId={null} />);
    expect(screen.getByTestId("publish-review-req-2")).toBeInTheDocument();
    expect(screen.queryByTestId("publish-review-reprepared")).toBeNull();
  });
});

// Publishing is invite-only: until the creator is approved, the panel offers to apply instead of Publish.
describe("PublishReviewPanel — creator approval", () => {
  it("none: no Publish button; the invite-only prompt with Apply to publish; Don't publish still works", () => {
    creator = { data: { status: "none" }, isPending: false };
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    arm();
    expect(screen.queryByTestId("publish-review-publish")).toBeNull();
    expect(screen.queryByTestId("publish-review-rights")).toBeNull();
    expect(screen.getByTestId("publish-review-creator-gate")).toHaveTextContent("Publishing to the public catalog is invite-only.");
    expect(screen.getByTestId("publish-review-apply")).toHaveTextContent("Apply to publish");
    fireEvent.click(discardButton());
    expect(discardMock).toHaveBeenCalledWith("req-1", expect.anything());
  });
  it.each([
    ["pending", "Your application is waiting for review — you can publish once you're approved."],
    ["rejected", "This creator key isn't approved for publishing."],
  ])("%s: its line instead of Publish", (status, copy) => {
    creator = { data: { status }, isPending: false };
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    expect(screen.queryByTestId("publish-review-publish")).toBeNull();
    expect(screen.queryByTestId("publish-review-rights")).toBeNull();
    expect(screen.getByTestId("publish-review-creator-gate")).toHaveTextContent(copy);
    expect(screen.queryByTestId("publish-review-apply")).toBeNull();
  });
  it("approved, unknown (the catalog didn't answer) and still loading: the Publish button as before — the site is the real gate", () => {
    for (const c of [{ data: { status: "approved" }, isPending: false }, { data: { status: null, error: "unreachable" }, isPending: false }, { data: undefined, isPending: true }]) {
      creator = c;
      render(<PublishReviewPanel r={view()} highlighted={false} />);
      expect(screen.getByTestId("publish-review-publish"), JSON.stringify(c)).toBeInTheDocument();
      expect(screen.getByTestId("publish-review-rights"), JSON.stringify(c)).toBeInTheDocument();
      expect(screen.queryByTestId("publish-review-creator-gate")).toBeNull();
      cleanup();
    }
  });
});

// The creator confirms they hold the rights, every time: a required box above the warning.
describe("PublishReviewPanel — rights confirmation", () => {
  it("a box labelled with the rights promise, unticked at first; Publish stays off past the arm delay until it is ticked", () => {
    expect(RIGHTS_CONFIRMATION_LABEL).toBe(
      "I own or have the rights to everything in this template, including its example video, images, fonts, voices and music",
    );
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    const box = screen.getByRole("checkbox", { name: RIGHTS_CONFIRMATION_LABEL });
    expect(box).toBe(screen.getByTestId("publish-review-rights"));
    expect(box).not.toBeChecked();
    arm();
    expectOff(publishButton());
    fireEvent.click(publishButton());
    expect(confirmMock).not.toHaveBeenCalled();
    tickRights();
    expect(box).toBeChecked();
    expectOn(publishButton());
    fireEvent.click(publishButton());
    expect(confirmMock).toHaveBeenCalledWith({ id: "req-1", confirmCode: "the-code", rightsConfirmed: true }, expect.any(Object));
  });

  // BC review M2: a disabled button that doesn't say why reads as broken.
  it("while only the rights box holds it back, Publish says why — beside it, and tied to it for a screen reader — and stays reachable", () => {
    expect(RIGHTS_HINT).toBe("Confirm you hold the rights to publish");
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    arm();
    const hint = screen.getByTestId("publish-review-rights-hint");
    expect(hint).toHaveTextContent(RIGHTS_HINT);
    const button = publishButton();
    expectOff(button);
    // Focusable-disabled, not natively disabled: a keyboard user lands on it and hears the reason.
    expect(button).not.toHaveAttribute("disabled");
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-describedby", hint.id);
    expect(button).toHaveAccessibleDescription(RIGHTS_HINT);
    tickRights();
    expect(screen.queryByTestId("publish-review-rights-hint")).toBeNull();
    expect(publishButton()).not.toHaveAttribute("aria-describedby");
  });

  it("no rights hint where the box isn't what holds Publish back: the creator gate, or a publish running", () => {
    creator = { data: { status: "pending" }, isPending: false };
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    expect(screen.queryByTestId("publish-review-rights-hint")).toBeNull();
    cleanup();
    creator = { data: { status: "approved" }, isPending: false };
    render(<PublishReviewPanel r={view({ state: "publishing" })} highlighted={false} />);
    expect(screen.queryByTestId("publish-review-rights-hint")).toBeNull();
  });

  it("clicking the label's text ticks it too, and a second click unticks it", () => {
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    arm();
    fireEvent.click(screen.getByText(RIGHTS_CONFIRMATION_LABEL));
    expect(screen.getByRole("checkbox", { name: RIGHTS_CONFIRMATION_LABEL })).toBeChecked();
    expectOn(publishButton());
    tickRights();
    expect(screen.getByRole("checkbox", { name: RIGHTS_CONFIRMATION_LABEL })).not.toBeChecked();
    expectOff(publishButton());
  });

  it("the label is interactive-looking (cursor-pointer) and sits above the public warning", () => {
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    const label = screen.getByText(RIGHTS_CONFIRMATION_LABEL).closest("label")!;
    expect(label).toHaveClass("cursor-pointer");
    expect(screen.getByTestId("publish-review-rights")).toHaveClass("cursor-pointer");
    expect(label.compareDocumentPosition(screen.getByTestId("publish-review-warning")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the tick resets when the request is prepared again (a new id), and survives a new state of the same one", () => {
    const { rerender } = render(<PublishReviewPanel r={view({ id: "req-1" })} highlighted={false} />);
    tickRights();
    rerender(<PublishReviewPanel r={view({ id: "req-1", state: "failed", error: "Paused.", confirmCode: "c2" })} highlighted={false} />);
    expect(screen.getByTestId("publish-review-rights")).toBeChecked();
    rerender(<PublishReviewPanel r={view({ id: "req-2" })} highlighted={false} />);
    expect(screen.getByTestId("publish-review-rights")).not.toBeChecked();
    arm();
    expectOff(publishButton());
  });

  it("while publishing, the box can't be changed", () => {
    render(<PublishReviewPanel r={view({ state: "publishing", confirmCode: undefined })} highlighted={false} />);
    expect(screen.getByTestId("publish-review-rights")).toHaveAttribute("aria-disabled", "true");
  });
});

describe("which catalog the review publishes to (review M6: from the request itself, always there)", () => {
  afterEach(() => {
    catalogView.current = undefined;
  });
  it("names the development catalog's host and its own Terms — with the page's catalog view not loaded at all", () => {
    catalogView.current = undefined;
    render(<PublishReviewPanel r={view({ catalog: { kind: "development", origin: "http://localhost:3300", host: "localhost:3300" } })} highlighted={false} />);
    expect(screen.getByTestId("publish-review-catalog")).toHaveTextContent("Publishes to the development catalog at localhost:3300.");
    expect(screen.getByTestId("publish-review-terms")).toHaveAttribute("href", "http://localhost:3300/terms#templates-catalog");
  });
  it("names the request's catalog even when the page's view says another one is active", () => {
    catalogView.current = { devBuild: true, active: { kind: "development", origin: "http://localhost:3300", host: "localhost:3300" }, legalOrigin: "http://localhost:3300" };
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    expect(screen.getByTestId("publish-review-catalog")).toHaveTextContent("Publishes to the public catalog at libi.nagellabs.com.");
  });
  // Review N2: the Terms follow the REQUEST's catalog for production too — right after another window
  // switched this build to Development, the page's links point at the development site.
  it("links a production request to production's Terms even while the page's links point at a development site", () => {
    catalogView.current = { devBuild: true, active: { kind: "development", origin: "http://localhost:3300", host: "localhost:3300" }, legalOrigin: "http://localhost:3300" };
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    expect(screen.getByTestId("publish-review-terms")).toHaveAttribute("href", "https://libi.nagellabs.com/terms#templates-catalog");
  });
  it("a test-mode request (no origin) keeps the page's own Terms", () => {
    catalogView.current = { devBuild: true, active: { kind: "test-mode", origin: null, host: null }, legalOrigin: "http://localhost:3300" };
    render(<PublishReviewPanel r={view({ catalog: { kind: "test-mode", origin: null, host: null } })} highlighted={false} />);
    expect(screen.getByTestId("publish-review-terms")).toHaveAttribute("href", "http://localhost:3300/terms#templates-catalog");
  });
  it("is there in a packaged build too, and names test mode's fixture", () => {
    const { unmount } = render(<PublishReviewPanel r={view()} highlighted={false} />);
    expect(screen.getByTestId("publish-review-catalog")).toHaveTextContent("Publishes to the public catalog at libi.nagellabs.com.");
    unmount();
    render(<PublishReviewPanel r={view({ catalog: { kind: "test-mode", origin: null, host: null } })} highlighted={false} />);
    expect(screen.getByTestId("publish-review-catalog")).toHaveTextContent("Publishes to the test-mode catalog.");
  });
});
