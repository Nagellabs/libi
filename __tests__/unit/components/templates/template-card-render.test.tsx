// @vitest-environment jsdom
//
// D4: a card with no example says which state it is in — "Render preview"
// when its source piece exists, the wait named on that button while the job
// runs, or a note that the source piece is gone. Installed templates keep
// their author's example and show neither.
//
// D2–D4 review: Render preview renders the source piece AS IT IS NOW, so it
// asks first, naming that piece (M6); a render that failed says why (M1).
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TemplateSummary } from "@/lib/templates/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/templates",
  useSearchParams: () => new URLSearchParams(""),
}));
vi.mock("@/hooks/agent/use-dispatch-to-agent", () => ({
  useDispatchToAgent: () => ({ open: false, setOpen: vi.fn(), prompt: "", send: vi.fn(), copy: vi.fn(), sending: false, openWith: vi.fn() }),
}));
vi.mock("@/components/agent/dispatch-to-agent-dialog", () => ({ DispatchToAgentDialog: () => null }));

import { TemplateCard, type InstalledTemplate } from "@/components/templates/templates-page/template-card";

function summary(over: Partial<TemplateSummary> = {}): InstalledTemplate {
  return {
    id: "t1", cloudId: null, name: "Lower third", description: "", tags: [], origin: "local", version: 2, hasCode: false,
    slots: [], slotCount: 0, canvas: { width: 1080, height: 1920, fps: 30 }, duration: 4, usesTotal: 0, uses7d: 0, lastUsedAt: null,
    createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", hasPoster: false, hasExample: false,
    poster: null, video: null, nickname: null, broken: null, otherCatalog: null, mediaRev: 0, canRenderExample: true, sourcePieceName: "Summer promo", sourceEmpty: false,
    ...over,
  } as InstalledTemplate;
}

let rendering: string[] = [];
let failed: Array<{ templateId: string; error: string }> = [];
const posts = vi.fn();
function routed(url: string, init?: RequestInit) {
  const u = String(url);
  if (u === "/api/templates/examples/rendering") return Promise.resolve({ ok: true, status: 200, json: async () => ({ templateIds: rendering, failed }) });
  if (u.endsWith("/example") && init?.method === "POST") {
    posts(u);
    rendering = ["t1"];
    failed = [];
    return Promise.resolve({ ok: true, status: 202, json: async () => ({ jobId: "job-1" }) });
  }
  return Promise.reject(new Error(`unexpected fetch ${u}`));
}

function mount(t: InstalledTemplate) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(
    <QueryClientProvider client={client}>
      <ul>
        <TemplateCard t={t} highlighted={false} />
      </ul>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  rendering = [];
  failed = [];
  posts.mockReset();
  vi.stubGlobal("fetch", vi.fn(routed));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TemplateCard — no example yet", () => {
  it("Render preview asks first, naming the source piece as it is now; confirmed, it starts the render and names the wait on the same button", async () => {
    mount(summary());
    const button = await screen.findByTestId("template-card-render");
    expect(button.textContent).toContain("Render preview");
    expect(button.className).toContain("cursor-pointer");
    fireEvent.click(button);
    const dialog = await screen.findByTestId("template-render-confirm");
    expect(dialog.textContent).toContain("“Summer promo” as it is now");
    expect(posts).not.toHaveBeenCalled();
    const go = screen.getByTestId("template-render-confirm-go");
    expect(go.className).toContain("cursor-pointer");
    fireEvent.click(go);
    await waitFor(() => expect(posts).toHaveBeenCalledWith("/api/templates/t1/example"));
    await waitFor(() => expect(screen.getByTestId("template-card-render").textContent).toContain("Rendering preview…"));
    expect(screen.getByTestId("template-card-render").getAttribute("aria-disabled") === "true" || (screen.getByTestId("template-card-render") as HTMLButtonElement).disabled).toBe(true);
  });

  it("Cancel in the confirm renders nothing", async () => {
    mount(summary());
    fireEvent.click(await screen.findByTestId("template-card-render"));
    fireEvent.click(await screen.findByTestId("template-render-confirm-cancel"));
    await waitFor(() => expect(screen.queryByTestId("template-render-confirm")).toBeNull());
    expect(posts).not.toHaveBeenCalled();
  });

  it("a render that failed says why beside Render preview; a new render in flight hides it", async () => {
    failed = [{ templateId: "t1", error: "the example export failed: no duration" }];
    mount(summary());
    const note = await screen.findByTestId("template-card-render-failed");
    expect(note.textContent).toBe("Preview failed: the example export failed: no duration");
    expect(screen.getByTestId("template-card-render").textContent).toContain("Render preview");
    fireEvent.click(screen.getByTestId("template-card-render"));
    fireEvent.click(await screen.findByTestId("template-render-confirm-go"));
    await waitFor(() => expect(screen.queryByTestId("template-card-render-failed")).toBeNull());
  });

  it("a render already in flight (started by the agent) shows as the wait from the start", async () => {
    rendering = ["t1"];
    mount(summary());
    await waitFor(() => expect(screen.getByTestId("template-card-render").textContent).toContain("Rendering preview…"));
  });

  it("a source piece named \"\" still exists: Render preview, not 'the source piece is gone' (fix-round review N9)", async () => {
    mount(summary({ sourcePieceName: "" }));
    expect(await screen.findByTestId("template-card-render")).toBeTruthy();
    expect(screen.queryByTestId("template-card-source-gone")).toBeNull();
  });

  it("the source piece is gone: a note, no button", async () => {
    mount(summary({ canRenderExample: false }));
    expect(screen.getByTestId("template-card-source-gone").textContent).toBe("No preview — the source piece is gone.");
    expect(screen.queryByTestId("template-card-render")).toBeNull();
  });

  // TPL-3: a template made from an empty piece never got a template_example
  // job started for it (mcp/tools/template-tools.ts), so there is no
  // "Render preview" for the user to press — a note explains why instead.
  it("the source piece was empty: a note, no button", async () => {
    mount(summary({ sourceEmpty: true }));
    expect(screen.getByTestId("template-card-source-empty").textContent).toBe("No preview — the piece is empty.");
    expect(screen.queryByTestId("template-card-render")).toBeNull();
    expect(screen.queryByTestId("template-card-source-gone")).toBeNull();
  });

  it("an installed template shows neither", () => {
    mount(summary({ origin: "installed", canRenderExample: false }));
    expect(screen.queryByTestId("template-card-render")).toBeNull();
    expect(screen.queryByTestId("template-card-source-gone")).toBeNull();
  });

  it("a card with an example shows neither — and its media URLs carry the version and the media revision", () => {
    mount(summary({ hasExample: true, hasPoster: true, mediaRev: 1234 }));
    expect(screen.queryByTestId("template-card-render")).toBeNull();
    expect(screen.queryByTestId("template-card-source-gone")).toBeNull();
    expect(document.querySelector("img")?.getAttribute("src")).toBe("/api/templates/t1/media/poster.jpg?v=2-1234");
  });
});

describe("TemplateCard — a published card's catalog status (final review F10/F12)", () => {
  const mineEntry = (over: Record<string, unknown>) =>
    ({ id: "cccccccccccccccccccc", name: "x", version: 1, hidden: false, moderated: false, indexPending: false, usesTotal: 0, uses7d: 0, byDay: {}, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z", ...over }) as never;
  function mountPublished(published: unknown) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return render(
      <QueryClientProvider client={client}>
        <ul>
          <TemplateCard t={summary({ cloudId: "cccccccccccccccccccc", hasExample: true, hasPoster: true })} highlighted={false} published={published as never} />
        </ul>
      </QueryClientProvider>,
    );
  }

  it("a moderated card shows the takedown date the Terms count from — the UTC day — and none it can't read", () => {
    const at = "2026-09-26T05:30:00.000Z";
    mountPublished(mineEntry({ hidden: true, moderated: true, moderation: { reason: "copyright", note: null, at } }));
    expect(screen.getByTestId("visibility-removed").textContent).toBe("Removed — Copyright");
    const date = screen.getByTestId("visibility-removed-date");
    expect(date.textContent).toBe("on 26 Sep 2026 (UTC)");
    expect(date.getAttribute("title")).toMatch(/September 2026/);
    expect(screen.getByTestId("template-card-moderated").textContent).toBe("Edits stay on this machine: the catalog won't take a new version of a moderated template.");
    cleanup();
    mountPublished(mineEntry({ hidden: true, moderated: true, moderation: { reason: "reports", note: null, at } }));
    expect(screen.getByTestId("visibility-removed").textContent).toBe("Hidden after reports — pending review");
    expect(screen.getByTestId("visibility-removed-date").textContent).toBe("on 26 Sep 2026 (UTC)");
    cleanup();
    mountPublished(mineEntry({ hidden: true, moderated: true, moderation: { reason: "copyright", note: null, at: "garbage" } }));
    expect(screen.getByTestId("template-card-moderated")).toBeTruthy();
    expect(screen.queryByTestId("visibility-removed-date")).toBeNull();
  });

  it("a published card offers Hide; a hidden one Show again; an unpublished card shows no catalog status", () => {
    mountPublished(mineEntry({}));
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
    cleanup();
    mountPublished(mineEntry({ hidden: true }));
    expect(screen.getByRole("button", { name: "Show again" })).toBeTruthy();
    cleanup();
    mountPublished(null);
    expect(screen.queryByTestId("template-card-catalog")).toBeNull();
  });
});
