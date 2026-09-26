// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TemplateSummary } from "@/lib/templates/types";

const push = vi.hoisted(() => vi.fn());
const openWith = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/templates",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/hooks/agent/use-dispatch-to-agent", () => ({
  useDispatchToAgent: () => ({ open: false, setOpen: vi.fn(), prompt: "", send: vi.fn(), copy: vi.fn(), sending: false, openWith }),
}));
vi.mock("@/components/agent/dispatch-to-agent-dialog", () => ({ DispatchToAgentDialog: () => null }));

import { TemplateCard, type InstalledTemplate } from "@/components/templates/templates-page/template-card";

function summary(over: Partial<TemplateSummary> = {}): InstalledTemplate {
  return {
    id: "t1", cloudId: null, name: "Lower third", description: "A name card", tags: ["promo"], origin: "local", version: 1, hasCode: false,
    slots: [], slotCount: 0, canvas: { width: 1080, height: 1920, fps: 30 }, duration: 4, usesTotal: 3, uses7d: 2, lastUsedAt: null,
    createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", hasPoster: true, hasExample: true,
    poster: "/api/templates/t1/media/poster.jpg", video: "/api/templates/t1/media/example.mp4", nickname: null, broken: null, otherCatalog: null,
    mediaRev: 0, canRenderExample: true, sourcePieceName: "Summer promo",
    ...over,
  } as InstalledTemplate;
}

function mount(cards: InstalledTemplate[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ul>
        {cards.map((t) => (
          <TemplateCard key={t.id} t={t} highlighted={false} />
        ))}
      </ul>
    </QueryClientProvider>,
  );
}

let play: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ templateIds: [], failed: [] }) })));
  push.mockReset();
  openWith.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const card = (id: string) => screen.getAllByTestId("template-card").find((c) => c.getAttribute("data-template-id") === id)!;

describe("TemplateCard — play from the grid (D3)", () => {
  it("the play button plays the example inline with sound and controls", async () => {
    mount([summary()]);
    const button = screen.getByTestId("template-card-play");
    expect(button.getAttribute("aria-label")).toBe("Play example with sound");
    expect(button.className).toContain("cursor-pointer");
    fireEvent.click(button);
    const video = (await screen.findByTestId("template-card-inline-video")) as HTMLVideoElement;
    expect(video.hasAttribute("controls")).toBe(true);
    expect(video.muted).toBe(false);
    expect(video.hasAttribute("muted")).toBe(false);
    expect(video.getAttribute("src")).toContain("example.mp4");
    await waitFor(() => expect(play).toHaveBeenCalled());
    // Playing the example is not opening the template.
    expect(push).not.toHaveBeenCalled();
  });

  it("Escape in the player and the clip's end stop it and bring the poster back", async () => {
    mount([summary()]);
    fireEvent.click(screen.getByTestId("template-card-play"));
    fireEvent.keyDown(await screen.findByTestId("template-card-inline-video"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("template-card-inline-video")).toBeNull());
    fireEvent.click(screen.getByTestId("template-card-play"));
    fireEvent.ended(await screen.findByTestId("template-card-inline-video"));
    await waitFor(() => expect(screen.queryByTestId("template-card-inline-video")).toBeNull());
  });

  it("one card at a time: playing B stops A", async () => {
    mount([summary(), summary({ id: "t2", name: "Hook" })]);
    fireEvent.click(within(card("t1")).getByTestId("template-card-play"));
    await waitFor(() => expect(within(card("t1")).getByTestId("template-card-inline-video")).toBeTruthy());
    fireEvent.click(within(card("t2")).getByTestId("template-card-play"));
    await waitFor(() => expect(within(card("t2")).getByTestId("template-card-inline-video")).toBeTruthy());
    expect(within(card("t1")).queryByTestId("template-card-inline-video")).toBeNull();
  });

  it("hovering another card while one plays inline previews it muted and does not stop the inline one", async () => {
    mount([summary(), summary({ id: "t2", name: "Hook" })]);
    fireEvent.click(within(card("t1")).getByTestId("template-card-play"));
    await waitFor(() => expect(within(card("t1")).getByTestId("template-card-inline-video")).toBeTruthy());
    fireEvent.mouseEnter(card("t2"));
    await waitFor(() => expect(within(card("t2")).getByTestId("template-card-video").className).not.toContain("hidden"));
    expect((within(card("t2")).getByTestId("template-card-video") as HTMLVideoElement).muted).toBe(true);
    expect(within(card("t1")).getByTestId("template-card-inline-video")).toBeTruthy();
    // And leaving/re-entering the playing card does not start its hover preview over the inline player.
    fireEvent.mouseLeave(card("t1"));
    fireEvent.mouseEnter(card("t1"));
    expect(within(card("t1")).getByTestId("template-card-inline-video")).toBeTruthy();
    expect(within(card("t1")).getByTestId("template-card-video").className).toContain("hidden");
  });

  it("an Escape meant for something else on the page (a Select, a menu) does not stop it (review M8)", async () => {
    mount([summary()]);
    fireEvent.click(screen.getByTestId("template-card-play"));
    await screen.findByTestId("template-card-inline-video");
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.getByTestId("template-card-inline-video")).toBeTruthy();
  });

  it("a visible Stop control ends it for a mouse user", async () => {
    mount([summary()]);
    fireEvent.click(screen.getByTestId("template-card-play"));
    await screen.findByTestId("template-card-inline-video");
    const stopButton = screen.getByTestId("template-card-inline-stop");
    expect(stopButton.getAttribute("aria-label")).toBe("Stop example");
    expect(stopButton.className).toContain("cursor-pointer");
    fireEvent.click(stopButton);
    await waitFor(() => expect(screen.queryByTestId("template-card-inline-video")).toBeNull());
    expect(push).not.toHaveBeenCalled();
  });

  it("no example, no play button", () => {
    mount([summary({ hasExample: false, video: null })]);
    expect(screen.queryByTestId("template-card-play")).toBeNull();
  });
});

describe("TemplateCard — the card opens its page (D3)", () => {
  it("clicking the card body opens /templates/<id>; the name is a link to the same page", () => {
    mount([summary()]);
    const root = screen.getByTestId("template-card");
    expect(root.className).toContain("cursor-pointer");
    fireEvent.click(within(root).getByText("A name card"));
    expect(push).toHaveBeenCalledWith("/templates/t1");
    const link = within(screen.getByTestId("template-card-name")).getByRole("link");
    expect(link.getAttribute("href")).toBe("/templates/t1");
  });

  it("Use, Delete and play do not navigate", async () => {
    mount([summary()]);
    fireEvent.click(screen.getByTestId("template-use"));
    fireEvent.click(screen.getByTestId("template-card-play"));
    fireEvent.click(screen.getByTestId("template-delete"));
    // The delete dialog is portalled out of the card, but React still bubbles its clicks to the card.
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(push).not.toHaveBeenCalled();
  });
});

describe("TemplateCard — the player's accessibility (D2–D4 review I3)", () => {
  it("the play button, the inline player and its Stop sit beside the preview image, never inside role=img", async () => {
    mount([summary()]);
    const image = screen.getByRole("img", { name: "Template preview" });
    expect(image.contains(screen.getByTestId("template-card-play"))).toBe(false);
    fireEvent.click(screen.getByTestId("template-card-play"));
    const video = await screen.findByTestId("template-card-inline-video");
    expect(screen.getByRole("img", { name: "Template preview" }).contains(video)).toBe(false);
    expect(screen.getByRole("img", { name: "Template preview" }).contains(screen.getByTestId("template-card-inline-stop"))).toBe(false);
    // A screen reader can reach both by role and name.
    expect(screen.getByRole("button", { name: "Stop example" })).toBeTruthy();
  });

  it("focus moves to the player when it starts, and back to the play button when it stops", async () => {
    mount([summary()]);
    const button = screen.getByTestId("template-card-play");
    button.focus();
    fireEvent.click(button);
    const video = await screen.findByTestId("template-card-inline-video");
    await waitFor(() => expect(document.activeElement).toBe(video));
    fireEvent.keyDown(video, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("template-card-play")));
    // The same from the Stop control.
    fireEvent.click(screen.getByTestId("template-card-play"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("template-card-inline-video")));
    const stopButton = screen.getByTestId("template-card-inline-stop");
    stopButton.focus();
    fireEvent.click(stopButton);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("template-card-play")));
  });

  it("a card stopped because another started does not take the focus back", async () => {
    mount([summary(), summary({ id: "t2", name: "Hook" })]);
    fireEvent.click(within(card("t1")).getByTestId("template-card-play"));
    await waitFor(() => expect(document.activeElement).toBe(within(card("t1")).getByTestId("template-card-inline-video")));
    const second = within(card("t2")).getByTestId("template-card-play");
    second.focus();
    fireEvent.click(second);
    await waitFor(() => expect(document.activeElement).toBe(within(card("t2")).getByTestId("template-card-inline-video")));
    expect(within(card("t1")).queryByTestId("template-card-inline-video")).toBeNull();
  });

  it("tabbing onto the play button does not start the muted hover preview; focusing the image still does", async () => {
    mount([summary()]);
    act(() => screen.getByTestId("template-card-play").focus());
    expect(screen.getByTestId("template-card-video").className).toContain("hidden");
    act(() => screen.getByRole("img", { name: "Template preview" }).focus());
    await waitFor(() => expect(screen.getByTestId("template-card-video").className).not.toContain("hidden"));
  });
});
