// @vitest-environment jsdom
//
// EL-1: in the desktop app, "Publish publicly" asks Electron main for a native
// confirm first — an extra gate on top of the page's own (arming delay, rights
// box, browser-only confirm route), never a replacement. Cancel sends nothing
// and says nothing; Publish sends exactly what the click would have sent
// without it; no bridge (web/npx, an older shell) publishes as before.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import type { PublishRequestView } from "@/lib/templates/types";

const confirmMock = vi.fn();
const discardMock = vi.fn();

vi.mock("@/lib/queries/templates-catalog", async () => {
  const { LEGAL_LINKS } = await import("@/lib/legal-links");
  return { useLegalLinks: () => LEGAL_LINKS, useTemplatesCatalog: () => ({ data: undefined }) };
});
vi.mock("@/lib/queries/templates-cloud", () => ({
  CloudRouteError: class extends Error {},
  useConfirmPublishRequest: () => ({ mutate: confirmMock, isPending: false, isSuccess: false }),
  useDiscardPublishRequest: () => ({ mutate: discardMock, isPending: false }),
  usePublishRequests: () => ({ data: [] }),
  useCreatorStatus: () => ({ data: { status: "approved" }, isPending: false }),
  useApplyAsCreator: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, error: null }),
}));
import { PUBLISH_ARM_DELAY_MS, PublishReviewPanel } from "@/components/templates/templates-page/publish-review";

const view = (over: Partial<PublishRequestView> = {}): PublishRequestView => ({
  id: "req-1",
  templateId: "t1",
  state: "awaiting",
  name: "Monday reset hook",
  description: "A Monday hook",
  tags: ["monday"],
  example: { kind: "file", fileId: "file-1", filename: "clip.mp4", pieceName: "Monday" },
  media: { videoUrl: "/v.mp4", posterUrl: "/p.jpg", exampleBytes: 1000, posterBytes: 100 },
  nickname: { value: "nadav", isNew: false, replaces: null },
  publicItems: [{ label: "Your public nickname", detail: "nadav" }],
  republish: false,
  catalog: { kind: "production", origin: "https://libi.nagellabs.com", host: "libi.nagellabs.com" },
  error: null,
  confirmCode: "the-code",
  createdAt: 1,
  ...over,
});

const setBridge = (api: unknown) => {
  (window as unknown as { electronAPI?: unknown }).electronAPI = api;
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const publishButton = () => screen.getByTestId("publish-review-publish");
const discardButton = () => screen.getByTestId("publish-review-discard");
const isOff = (el: HTMLElement) => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

/** Render, let Publish arm, tick the rights box. */
function ready(r: PublishRequestView = view()) {
  render(<PublishReviewPanel r={r} highlighted={false} />);
  act(() => vi.advanceTimersByTime(PUBLISH_ARM_DELAY_MS));
  fireEvent.click(screen.getByTestId("publish-review-rights"));
}

/** Resolve the bridge's answer and let React settle. */
async function answer(resolve: (v: boolean) => void, value: boolean) {
  await act(async () => {
    resolve(value);
    await Promise.resolve();
  });
}

describe("native publish confirm (desktop app)", () => {
  it("Cancel: the bridge was asked with the template's name and host; nothing is sent and no refusal is shown", async () => {
    let resolve!: (v: boolean) => void;
    const bridgeConfirm = vi.fn(() => new Promise<boolean>((r) => (resolve = r)));
    setBridge({ confirmPublish: bridgeConfirm, revealFile: vi.fn() });
    ready();
    fireEvent.click(publishButton());
    expect(bridgeConfirm).toHaveBeenCalledWith({ templateName: "Monday reset hook", catalogHost: "libi.nagellabs.com" });
    // While the native dialog is up, neither button can be pressed again, and the wait is named.
    expect(publishButton()).toHaveTextContent("Confirm in the dialog…");
    expect(isOff(publishButton())).toBe(true);
    expect(isOff(discardButton())).toBe(true);
    fireEvent.click(publishButton());
    expect(bridgeConfirm).toHaveBeenCalledTimes(1);
    await answer(resolve, false);
    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("publish-review-error")).toBeNull();
    // Back to a live Publish button for another go.
    expect(publishButton()).toHaveTextContent("Publish publicly");
    expect(isOff(publishButton())).toBe(false);
  });

  it("Publish: the confirm is sent once, with exactly the args a click sends without the dialog", async () => {
    let resolve!: (v: boolean) => void;
    setBridge({ confirmPublish: vi.fn(() => new Promise<boolean>((r) => (resolve = r))) });
    ready();
    fireEvent.click(publishButton());
    expect(confirmMock).not.toHaveBeenCalled();
    await answer(resolve, true);
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledWith({ id: "req-1", confirmCode: "the-code", rightsConfirmed: true }, expect.any(Object));
  });

  it("test mode has no catalog host: the dialog names the test-mode catalog", async () => {
    const bridgeConfirm = vi.fn(async () => false);
    setBridge({ confirmPublish: bridgeConfirm });
    ready(view({ catalog: { kind: "test-mode", origin: null, host: null } }));
    await act(async () => {
      fireEvent.click(publishButton());
      await Promise.resolve();
    });
    expect(bridgeConfirm).toHaveBeenCalledWith({ templateName: "Monday reset hook", catalogHost: "the test-mode catalog" });
  });

  it("a bridge that fails refuses to publish and says why (fails closed)", async () => {
    setBridge({ confirmPublish: vi.fn(async () => { throw new Error("ipc gone"); }) });
    ready();
    await act(async () => {
      fireEvent.click(publishButton());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("publish-review-error")).toHaveTextContent("The desktop app couldn't ask you to confirm. Try again.");
  });

  it("a name the desktop dialog refuses is said, not treated as a silent Cancel", async () => {
    setBridge({ confirmPublish: vi.fn(async () => "refused") });
    ready(view({ name: "Hook\u2028Publish anyway" }));
    await act(async () => {
      fireEvent.click(publishButton());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("publish-review-error")).toHaveTextContent(
      "The desktop app won't show this template's name in its confirmation: the name may not contain line breaks. Ask the agent to rename it and prepare the publish again.",
    );
  });

  it("a refused confirmation for a valid name names the real cause, not a name problem, and points at Settings", async () => {
    setBridge({ confirmPublish: vi.fn(async () => "refused") });
    ready(); // the default view() name has no singleLineTextProblem
    await act(async () => {
      fireEvent.click(publishButton());
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(confirmMock).not.toHaveBeenCalled();
    expect(screen.getByTestId("publish-review-error")).toHaveTextContent(
      "The desktop app refused to show its confirmation, so nothing was sent. If you're using a development catalog, check its address in Settings → Templates, then try again.",
    );
  });

  it("no bridge (web/npx): Publish sends at once, as today", () => {
    ready();
    fireEvent.click(publishButton());
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock).toHaveBeenCalledWith({ id: "req-1", confirmCode: "the-code", rightsConfirmed: true }, expect.any(Object));
  });

  it("an older shell's bridge without confirmPublish: Publish sends at once, as today", () => {
    setBridge({ revealFile: vi.fn(), pickDirectory: vi.fn() });
    ready();
    fireEvent.click(publishButton());
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it("the native confirm never replaces the page's own gates: unarmed or unticked, the bridge is not even asked", () => {
    const bridgeConfirm = vi.fn(async () => true);
    setBridge({ confirmPublish: bridgeConfirm });
    render(<PublishReviewPanel r={view()} highlighted={false} />);
    fireEvent.click(screen.getByTestId("publish-review-rights"));
    fireEvent.click(publishButton()); // not armed yet
    act(() => vi.advanceTimersByTime(PUBLISH_ARM_DELAY_MS));
    fireEvent.click(screen.getByTestId("publish-review-rights")); // untick
    fireEvent.click(publishButton());
    expect(bridgeConfirm).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });
});
