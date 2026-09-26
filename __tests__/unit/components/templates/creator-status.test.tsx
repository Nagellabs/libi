// @vitest-environment jsdom
//
// The creator's approval to publish on the Templates page: the status line
// under "Publishing as" (each state's exact copy; nothing when the catalog
// can't be reached; a skeleton while loading), the "Apply to publish" form
// (the privacy notice in view before sending, libi's own check before the
// server's, the wait named on Submit, the route's refusal inline), and the
// review panel's gate prompt.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

const mutateMock = vi.fn();
const resetMock = vi.fn();
let creator: { data?: { status: string | null; error?: string }; isPending: boolean };
let applyState: { isPending: boolean; error: Error | null };

// The catalog view (a dev build's catalog switch) is not under test here: the build's own site's links, no view.
vi.mock("@/lib/queries/templates-catalog", async () => {
  const { LEGAL_LINKS } = await import("@/lib/legal-links");
  return { useLegalLinks: () => LEGAL_LINKS, useTemplatesCatalog: () => ({ data: undefined }) };
});
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/queries/templates-cloud", () => ({
  CloudRouteError: class CloudRouteError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly code?: string,
    ) {
      super(message);
    }
  },
  useCreatorStatus: () => creator,
  useApplyAsCreator: () => ({ mutate: mutateMock, reset: resetMock, ...applyState }),
}));
import { toast } from "sonner";
import { CloudRouteError } from "@/lib/queries/templates-cloud";
import { LEGAL_LINKS } from "@/lib/legal-links";
import { APPLY_NOTICE, CREATOR_COPY, CreatorGatePrompt, CreatorStatusLine } from "@/components/templates/templates-page/creator-status";
import { OPENS_OUTSIDE_TEXT } from "@/components/templates/templates-page/opens-outside";

beforeEach(() => {
  creator = { data: { status: "none" }, isPending: false };
  applyState = { isPending: false, error: null };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const line = () => screen.getByTestId("creator-status");
const openForm = () => fireEvent.click(screen.getByTestId("creator-apply"));

describe("CreatorStatusLine", () => {
  it("none: the invite-only line and an Apply to publish button", () => {
    render(<CreatorStatusLine />);
    expect(line()).toHaveAttribute("data-status", "none");
    expect(line()).toHaveTextContent(CREATOR_COPY.none);
    expect(screen.getByTestId("creator-apply")).toHaveTextContent(CREATOR_COPY.apply);
    expect(CREATOR_COPY.none).toBe("Publishing to the public catalog is invite-only.");
    expect(CREATOR_COPY.apply).toBe("Apply to publish");
  });
  it.each([
    ["pending", "Application received — we'll review it"],
    ["approved", "Approved creator"],
    ["rejected", "Not approved for publishing"],
  ])("%s: its exact copy, and no button", (status, copy) => {
    creator = { data: { status }, isPending: false };
    render(<CreatorStatusLine />);
    expect(line()).toHaveAttribute("data-status", status);
    expect(line()).toHaveTextContent(copy);
    expect(CREATOR_COPY[status as keyof typeof CREATOR_COPY]).toBe(copy);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("the catalog couldn't be reached (status null): nothing at all", () => {
    creator = { data: { status: null, error: "unreachable" }, isPending: false };
    const { container } = render(<CreatorStatusLine />);
    expect(container).toBeEmptyDOMElement();
  });
  it("loading: a skeleton, never a spinner or 'Loading…'", () => {
    creator = { data: undefined, isPending: true };
    render(<CreatorStatusLine />);
    expect(screen.getByTestId("creator-status-skeleton")).toBeInTheDocument();
    expect(screen.queryByText(/loading/i)).toBeNull();
  });
});

describe("ApplyToPublishDialog", () => {
  it("opens from the status line, with the privacy notice and its link in view before sending", () => {
    render(<CreatorStatusLine />);
    openForm();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/We send your email, your note, your public nickname and your creator id/)).toBeInTheDocument();
    // It leaves libi, and its name says so (BC review M5).
    const link = screen.getByRole("link", { name: `Privacy Policy ${OPENS_OUTSIDE_TEXT}` });
    expect(link).toHaveAttribute("href", LEGAL_LINKS.privacy);
    expect(link).toHaveAttribute("target", "_blank");
  });
  // Review I1: an approved creator's application IS the approval, so it is kept while they stay approved —
  // the notice must say so, as the site's Privacy Policy (§5.5, "Applying to publish") does.
  it("the notice states all three retention periods, in the Privacy Policy's terms", () => {
    expect(APPLY_NOTICE).toContain(
      "We keep it until we decide, for as long as you're an approved creator, and for 12 months after we decline it or withdraw approval.",
    );
    expect(APPLY_NOTICE).not.toMatch(/after a rejection/);
  });
  it("a bad email is refused inline and nothing is sent; a good one sends the email and the note", () => {
    render(<CreatorStatusLine />);
    openForm();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "nope" } });
    fireEvent.click(screen.getByTestId("creator-apply-submit"));
    expect(screen.getByRole("alert")).toHaveTextContent("That doesn't look like a valid email.");
    expect(mutateMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: " a@b.co " } });
    fireEvent.change(screen.getByLabelText("What would you publish? (optional)"), { target: { value: "hooks" } });
    expect(screen.getByText("5/500")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("creator-apply-submit"));
    expect(mutateMock).toHaveBeenCalledWith({ email: "a@b.co", note: "hooks" }, expect.anything());
  });
  it("on success: closes and says so", () => {
    mutateMock.mockImplementation((_v, opts: { onSuccess?: () => void }) => opts.onSuccess?.());
    render(<CreatorStatusLine />);
    openForm();
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "a@b.co" } });
    fireEvent.click(screen.getByTestId("creator-apply-submit"));
    expect(toast.success).toHaveBeenCalledWith("Application sent — we'll review it.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("while sending, Submit names the wait and the inputs are locked", () => {
    applyState = { isPending: true, error: null };
    render(<CreatorStatusLine />);
    openForm();
    const submit = screen.getByTestId("creator-apply-submit");
    expect(submit).toHaveTextContent("Sending…");
    expect(submit.hasAttribute("disabled") || submit.getAttribute("aria-disabled") === "true").toBe(true);
    expect(screen.getByLabelText("Email")).toBeDisabled();
    expect(screen.getByLabelText("What would you publish? (optional)")).toBeDisabled();
  });
  it("the route's refusal shows inline, and the form stays open", () => {
    applyState = { isPending: false, error: new CloudRouteError("Your application to publish was already decided. Email admin@nagellabs.com if you think that's a mistake.", 409, "creator_request_closed") };
    render(<CreatorStatusLine />);
    openForm();
    expect(screen.getByRole("alert")).toHaveTextContent("Your application to publish was already decided.");
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("every interactive element has cursor-pointer", () => {
    render(<CreatorStatusLine />);
    expect(screen.getByTestId("creator-apply")).toHaveClass("cursor-pointer");
    openForm();
    // Real buttons and links only: the dialog's invisible focus guards carry role="button" too.
    const interactive = [...document.body.querySelectorAll("button, a[href]")];
    expect(interactive.length).toBeGreaterThanOrEqual(4); // close, Cancel, Submit, Privacy Policy
    for (const el of interactive) expect(el, el.outerHTML.slice(0, 200)).toHaveClass("cursor-pointer");
  });
});

describe("CreatorGatePrompt", () => {
  it("none: invite-only, with Apply to publish", () => {
    render(<CreatorGatePrompt status="none" />);
    expect(screen.getByTestId("publish-review-creator-gate")).toHaveTextContent("Publishing to the public catalog is invite-only.");
    fireEvent.click(screen.getByTestId("publish-review-apply"));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });
  it("pending and rejected: their lines, no Apply", () => {
    render(<CreatorGatePrompt status="pending" />);
    expect(screen.getByTestId("publish-review-creator-gate")).toHaveTextContent("Your application is waiting for review — you can publish once you're approved.");
    expect(screen.queryByTestId("publish-review-apply")).toBeNull();
    cleanup();
    render(<CreatorGatePrompt status="rejected" />);
    expect(screen.getByTestId("publish-review-creator-gate")).toHaveTextContent("This creator key isn't approved for publishing.");
    expect(screen.queryByTestId("publish-review-apply")).toBeNull();
  });
});
