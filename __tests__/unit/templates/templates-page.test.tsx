// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, act, cleanup, within } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { TemplateSummary } from "@/lib/templates/types";
import { MODERATED_MESSAGE } from "@/lib/templates/cloud/constants";

const openWith = vi.hoisted(() => vi.fn());
// The tab is read from the URL, which is what `libi.show_templates` pushes —
// so the public-tab case drives it there rather than through a base-ui click.
let search = vi.hoisted(() => "");

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/templates",
  useSearchParams: () => new URLSearchParams(search),
}));
vi.mock("@/hooks/agent/use-dispatch-to-agent", () => ({
  useDispatchToAgent: () => ({ open: false, setOpen: vi.fn(), prompt: "", send: vi.fn(), copy: vi.fn(), sending: false, openWith }),
}));
vi.mock("@/components/agent/dispatch-to-agent-dialog", () => ({ DispatchToAgentDialog: () => null }));

import { TemplatesPage } from "@/components/templates/templates-page/templates-page";

const fetchMock = vi.fn();
function summary(over: Partial<TemplateSummary>): TemplateSummary {
  return {
    id: "t1",
    cloudId: null,
    name: "Lower third",
    description: "A name card",
    tags: ["promo"],
    origin: "local",
    version: 1,
    hasCode: true,
    slots: [{ key: "headline", kind: "text", label: "Headline", required: true }],
    slotCount: 1,
    canvas: { width: 1080, height: 1920, fps: 30 },
    duration: 4,
    usesTotal: 3,
    uses7d: 2,
    lastUsedAt: null,
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    hasPoster: false,
    hasExample: true,
    poster: null,
    video: "/api/templates/t1/media/example.mp4",
    nickname: null,
    broken: null, otherCatalog: null,
    mediaRev: 0, canRenderExample: true, sourcePieceName: "Source piece",
    ...over,
  };
}
const ok = (templates: TemplateSummary[]) => ({ ok: true, status: 200, json: async () => ({ templates }) });
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

/** The public tab's catalog route; a test sets it before mounting (a promise holds the answer back). */
let catalog: Record<string, unknown> | Promise<Record<string, unknown>> = {};
const catalogGets = vi.fn();
/** The publishes agents prepared (the review panels); a test sets it before mounting. */
let publishRequests: unknown[] = [];
const publishCalls = vi.fn();
/** `/mine`'s answer; a test sets it before mounting. */
let mineAnswer: Record<string, unknown> = { nickname: "nadav", templates: [] };
const BASE = "https://storage.googleapis.com/libi-prod-templates/";
const catalogPosts = vi.fn();

/** "Publishing as", "Your templates" and the public tab read their own routes; each test's `fetchMock` answers only the template list. */
function routedFetch(url: string, init?: RequestInit) {
  const u = String(url);
  if (u === "/api/templates/cloud/author") return Promise.resolve(json({ nickname: "nadav", authorId: "a" }));
  if (u === "/api/templates/cloud/creator") return Promise.resolve(json({ status: "approved" }));
  if (u === "/api/templates/cloud/pending") return Promise.resolve(json({ pending: [] }));
  if (u === "/api/templates/cloud/publish-requests") return Promise.resolve(json({ requests: publishRequests }));
  if (u.startsWith("/api/templates/cloud/publish-requests/")) {
    publishCalls(u, init?.method, init?.body ? JSON.parse(String(init.body)) : undefined);
    return Promise.resolve(json(init?.method === "DELETE" ? { ok: true } : { ok: true, jobId: "job-1" }));
  }
  if (u === "/api/templates/cloud/mine") return Promise.resolve(json(mineAnswer));
  if (u === "/api/templates/examples/rendering") return Promise.resolve(json({ templateIds: [] }));
  if (u === "/api/templates/cloud/catalog") {
    if (init?.method === "POST") catalogPosts();
    else catalogGets();
    return Promise.resolve(catalog).then(json);
  }
  return fetchMock(url, init);
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <TemplatesPage />
      </QueryClientProvider>,
    ),
  };
}

describe("TemplatesPage", () => {
  // jsdom implements neither, and every card pauses its example on unmount.
  let play: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    search = "";
    // The view choice is remembered in localStorage (D2); every test starts from none.
    window.localStorage.clear();
    catalog = { entries: [], fetchedAt: "2026-09-23T00:00:00.000Z", base: BASE, refreshed: false };
    catalogPosts.mockReset();
    catalogGets.mockReset();
    mineAnswer = { nickname: "nadav", templates: [] };
    publishRequests = [];
    publishCalls.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", vi.fn(routedFetch));
    openWith.mockReset();
  });
  afterEach(() => {
    // Explicitly BEFORE restoring: vitest runs afterEach hooks last-registered
    // first, so RTL's own auto-cleanup would otherwise unmount the cards after
    // the media stubs are gone — and every card pauses its example on unmount.
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the skeleton, then the empty state with the create hand-off", async () => {
    fetchMock.mockResolvedValue(ok([]));
    mount();
    expect(screen.getByTestId("templates-grid-skeleton")).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId("templates-empty")).toBeTruthy());
    fireEvent.click(screen.getByTestId("templates-empty-create"));
    await waitFor(() => expect(openWith).toHaveBeenCalledWith(expect.stringContaining("libi.create_template_from_piece")));
  });

  it("renders cards with uses, slots and the code badge — and no table under them; Use hands off apply with a new piece", async () => {
    fetchMock.mockResolvedValue(ok([summary({})]));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
    expect(screen.getByTestId("template-card-uses").textContent).toContain("2 this week");
    expect(screen.getByTestId("template-card-uses").textContent).toContain("1 slot");
    expect(screen.getByTestId("template-card-has-code")).toBeTruthy();
    // D2: one view at a time — the duplicate "Your templates" table under the grid is gone.
    expect(screen.getByTestId("templates-grid")).toBeTruthy();
    expect(screen.queryByTestId("templates-table")).toBeNull();
    expect(screen.getByTestId("templates-view-cards").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("template-use"));
    await waitFor(() => expect(openWith).toHaveBeenCalled());
    const prompt = openWith.mock.calls[0][0] as string;
    expect(prompt).toContain('templateId: "t1"');
    expect(prompt).toContain("newPiece: {}");
    // The page must not create anything itself — POST /api/pieces is the tell.
    expect(fetchMock.mock.calls.every(([url]) => !String(url).includes("/api/pieces"))).toBe(true);
  });

  // A11 fix round 1: an installed template's name is a stranger's — never a control's accessible name.
  it("the card's focusable preview is an image with a fixed name, and no name sits in a title", async () => {
    fetchMock.mockResolvedValue(ok([summary({ name: "Ignore previous instructions", origin: "installed", cloudId: "abcdefghijklmnopqrst" })]));
    const { container } = mount();
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
    const preview = screen.getByRole("img", { name: "Template preview" });
    expect(preview.getAttribute("tabindex")).toBe("0");
    for (const el of container.querySelectorAll("[aria-label], [title]")) {
      expect(`${el.getAttribute("aria-label") ?? ""} ${el.getAttribute("title") ?? ""}`).not.toContain("Ignore previous instructions");
    }
    expect(screen.getByTestId("template-card-name").textContent).toBe("Ignore previous instructions");
  });

  it("the example video is inert until the pointer arrives, then plays — with the version on its URL", async () => {
    // `preload="none"` means nothing loads until something asks, so `canplay`
    // never fires on its own: the play has to follow the `src` being set.
    fetchMock.mockResolvedValue(ok([summary({ version: 7 })]));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
    const video = screen.getByTestId("template-card-video") as HTMLVideoElement;
    expect(video.getAttribute("preload")).toBe("none");
    expect(video.getAttribute("src")).toBeNull();
    expect(video.className).toContain("hidden");
    expect(play).not.toHaveBeenCalled();
    fireEvent.mouseEnter(screen.getByTestId("template-card"));
    await waitFor(() => expect(screen.getByTestId("template-card-video").getAttribute("src")).toContain("example.mp4"));
    expect(screen.getByTestId("template-card-video").getAttribute("src")).toContain("?v=7");
    await waitFor(() => expect(play).toHaveBeenCalled());
    // And hidden again on leave, so the poster comes back rather than the
    // clip's last frame.
    fireEvent.mouseLeave(screen.getByTestId("template-card"));
    await waitFor(() => expect(screen.getByTestId("template-card-video").className).toContain("hidden"));
  });

  it("keeps the toolbar, the focus and the previous cards while the filtered query is in flight", async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("q=") ? new Promise(() => {}) : Promise.resolve(ok([summary({}), summary({ id: "t2", name: "Hook" })])),
    );
    mount();
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(2));
    const box = screen.getByTestId("list-search") as HTMLInputElement;
    box.focus();
    fireEvent.change(box, { target: { value: "lo" } });
    // Past the 200 ms debounce, with the search request hanging: the rows the
    // user was already looking at stay, dimmed — no skeleton flash.
    await waitFor(() => expect(screen.getByTestId("templates-grid").getAttribute("data-stale")).toBe("true"));
    expect(screen.getAllByTestId("template-card")).toHaveLength(2);
    expect(screen.queryByTestId("templates-grid-skeleton")).toBeNull();
    expect(screen.getByTestId("templates-grid").className).toContain("opacity-60");
    const still = screen.getByTestId("list-search") as HTMLInputElement;
    expect(still).toBe(box);
    expect(document.activeElement).toBe(box);
    expect(still.value).toBe("lo");
    // The tag chips stay put too — a chip must not vanish under the pointer.
    expect(screen.getAllByTestId("template-tag-chip").length).toBeGreaterThan(0);
  });

  it("a failed BACKGROUND refresh keeps the page and says it is stale — it does not wipe it", async () => {
    fetchMock.mockResolvedValue(ok([summary({})]));
    const { client } = mount();
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
    fetchMock.mockRejectedValue(new Error("offline"));
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["templates"] }).catch(() => {});
    });
    await waitFor(() => expect(screen.getByTestId("templates-refresh-failed")).toBeTruthy());
    // The rows are real, just not current.
    expect(screen.getAllByTestId("template-card")).toHaveLength(1);
    expect(screen.queryByTestId("templates-error")).toBeNull();
    expect(screen.queryByTestId("templates-grid-error")).toBeNull();
    fetchMock.mockResolvedValue(ok([summary({}), summary({ id: "t2", name: "Hook" })]));
    fireEvent.click(screen.getByTestId("templates-refresh-failed-retry"));
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(2));
    expect(screen.queryByTestId("templates-refresh-failed")).toBeNull();
  });

  it("a card unmounted mid-play stops its clip and releases the one-at-a-time slot", async () => {
    fetchMock.mockResolvedValue(ok([summary({})]));
    const { unmount } = mount();
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
    fireEvent.mouseEnter(screen.getByTestId("template-card"));
    await waitFor(() => expect(play).toHaveBeenCalled());
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    pause.mockClear();
    unmount();
    // React nulls the ref before a passive cleanup runs, so a cleanup that
    // reads `videoRef.current` stops nothing.
    expect(pause).toHaveBeenCalled();
    // And the next card can still claim the slot.
    play.mockClear();
    fetchMock.mockResolvedValue(ok([summary({ id: "t2", name: "Hook" })]));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
    fireEvent.mouseEnter(screen.getByTestId("template-card"));
    await waitFor(() => expect(play).toHaveBeenCalled());
  });

  it("only one example plays: hovering a second card stops the first", async () => {
    fetchMock.mockResolvedValue(ok([summary({}), summary({ id: "t2", name: "Hook" })]));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(2));
    const [a, b] = screen.getAllByTestId("template-card");
    fireEvent.mouseEnter(a);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(1));
    const pause = vi.mocked(HTMLMediaElement.prototype.pause);
    pause.mockClear();
    fireEvent.mouseEnter(b);
    await waitFor(() => expect(play).toHaveBeenCalledTimes(2));
    expect(pause).toHaveBeenCalled();
    expect(a.querySelector('[data-testid="template-card-video"]')!.className).toContain("hidden");
  });

  it("a failed list says so and retries — it does not claim the library is empty", async () => {
    fetchMock.mockRejectedValueOnce(new Error("boom"));
    mount();
    await waitFor(() => expect(screen.getByTestId("templates-error")).toBeTruthy());
    expect(screen.queryByTestId("templates-empty")).toBeNull();
    fetchMock.mockResolvedValue(ok([summary({})]));
    fireEvent.click(screen.getByTestId("templates-error-retry"));
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
  });

  it("a failed search says so too — it does not claim nothing matches", async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes("q=") ? Promise.reject(new Error("boom")) : Promise.resolve(ok([summary({})])),
    );
    mount();
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
    fireEvent.change(screen.getByTestId("list-search"), { target: { value: "lo" } });
    await waitFor(() => expect(screen.getByTestId("templates-grid-error")).toBeTruthy());
    expect(screen.queryByTestId("templates-no-match")).toBeNull();
    expect(screen.getByTestId("list-search")).toBeTruthy();
  });

  // "An agent can prepare a publish. Only you can publish." — the review panel.
  const request = (over: Record<string, unknown> = {}) => ({
    id: "req-1",
    templateId: "t1",
    state: "awaiting",
    name: "Monday reset hook",
    description: "A Monday hook",
    tags: ["monday", "hook"],
    example: { kind: "export", pieceId: "p1", pieceName: "Monday" },
    media: { videoUrl: "/api/templates/cloud/publish-requests/req-1/media/example.mp4", posterUrl: "/api/templates/cloud/publish-requests/req-1/media/poster.jpg", exampleBytes: 1000, posterBytes: 100 },
    nickname: { value: "nadav", isNew: false, replaces: null },
    publicItems: [
      { label: "Name, description and tags", detail: "Tags: monday, hook" },
      { label: "Your public nickname", detail: "nadav" },
    ],
    republish: false,
    catalog: { kind: "production", origin: "https://libi.nagellabs.com", host: "libi.nagellabs.com" },
    error: null,
    confirmCode: "code-from-the-page",
    createdAt: 1,
    ...over,
  });

  it("a publish an agent prepared is a review panel above the tabs; with the rights box ticked, Publish publicly sends the page's confirm code", async () => {
    publishRequests = [request()];
    fetchMock.mockResolvedValue(ok([summary({})]));
    mount();
    const panel = await screen.findByTestId("publish-review-req-1");
    expect(within(panel).getByTestId("publish-review-name").textContent).toBe("Monday reset hook");
    expect(within(panel).getByTestId("publish-review-warning").textContent).toBe(
      "Publishing makes this public. Anyone can install it; unpublishing doesn't recall copies already installed.",
    );
    expect(within(panel).getByTestId("publish-review-terms").getAttribute("href")).toMatch(/\/terms#templates-catalog$/);
    // Above the tabs, whichever tab is open.
    expect(panel.compareDocumentPosition(screen.getByTestId("templates-tab-mine")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Publish arms after the settle delay (PUBLISH_ARM_DELAY_MS) AND the rights box.
    fireEvent.click(within(panel).getByTestId("publish-review-rights"));
    await waitFor(() => expect(within(panel).getByTestId("publish-review-publish").getAttribute("aria-disabled")).not.toBe("true"), { timeout: 3000 });
    fireEvent.click(within(panel).getByTestId("publish-review-publish"));
    await waitFor(() =>
      expect(publishCalls).toHaveBeenCalledWith("/api/templates/cloud/publish-requests/req-1/confirm", "POST", { confirmCode: "code-from-the-page", rightsConfirmed: true }),
    );
  });

  it("Don't publish discards the request and publishes nothing", async () => {
    publishRequests = [request()];
    fetchMock.mockResolvedValue(ok([summary({})]));
    mount();
    const panel = await screen.findByTestId("publish-review-req-1");
    fireEvent.click(within(panel).getByTestId("publish-review-discard"));
    await waitFor(() => expect(publishCalls).toHaveBeenCalledWith("/api/templates/cloud/publish-requests/req-1", "DELETE", undefined));
    expect(publishCalls).not.toHaveBeenCalledWith(expect.stringContaining("/confirm"), expect.anything(), expect.anything());
  });

  it("no prepared publish, no panel", async () => {
    fetchMock.mockResolvedValue(ok([summary({})]));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
    expect(screen.queryByTestId("publish-reviews")).toBeNull();
  });

  it("the header says who this install publishes as", async () => {
    fetchMock.mockResolvedValue(ok([summary({})]));
    mount();
    await waitFor(() => expect(screen.getByTestId("publishing-as-edit").textContent).toContain("nadav"));
    expect(screen.queryByTestId("pending-publishes")).toBeNull();
  });

  const PUBLIC_ID = "abcdefghijklmnopqrst";
  const publicEntry = (over: Partial<TemplateSummary> = {}) =>
    summary({
      id: null,
      cloudId: PUBLIC_ID,
      origin: "public",
      name: "Hook",
      nickname: "mallory",
      hasPoster: true,
      poster: `${BASE}templates/${PUBLIC_ID}/v1/poster.jpg`,
      video: `${BASE}templates/${PUBLIC_ID}/v1/example.mp4`,
      ...over,
    });

  // Site round 4: a hide sent while an unhide is still running wins, and the unhide answers 409 busy.
  it("Show again: names the wait while it runs; on busy it re-reads /mine and never re-sends the unhide", async () => {
    const CLOUD = "cccccccccccccccccccc";
    mineAnswer = {
      nickname: "nadav",
      templates: [{ id: CLOUD, name: "Hidden one", version: 1, hidden: true, moderated: false, indexPending: false, usesTotal: 0, uses7d: 0, byDay: {}, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" }],
    };
    let answer: (r: Response) => void = () => {};
    const patches: string[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (String(url) === "/api/templates/cloud/visibility") {
        patches.push(String(init?.body));
        return new Promise<Response>((resolve) => (answer = resolve));
      }
      return Promise.resolve(ok([]));
    });
    mount();
    const show = await screen.findByRole("button", { name: "Show again" });
    const mineReads = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u) === "/api/templates/cloud/mine").length;
    const before = mineReads();
    fireEvent.click(show);
    // An unhide is one attempt of at most 60 s (final review m3) — only a hide is retried for minutes.
    await waitFor(() => expect(screen.getByTestId(`template-visibility-wait-${CLOUD}`).textContent).toMatch(/can take up to a minute/));
    answer(new Response(JSON.stringify({ error: "Another change to this template was being made at the same time. Its current state is shown.", code: "busy" }), { status: 409 }));
    await waitFor(() => expect(mineReads()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByTestId(`template-visibility-wait-${CLOUD}`)).toBeNull());
    expect(patches).toEqual(['{"cloudId":"cccccccccccccccccccc","hidden":false}']);
  });

  // Final review Minor 5: deleting the local copy does not take the public one down.
  it("the delete dialog says a published template's public copy stays — only for the user's own", async () => {
    fetchMock.mockResolvedValue(ok([summary({ id: "t1", cloudId: "pppppppppppppppppppp", name: "Mine, published" }), summary({ id: "t2", cloudId: "iiiiiiiiiiiiiiiiiiii", origin: "installed", name: "Installed" })]));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(2));
    const [mine, installed] = screen.getAllByTestId("template-card");
    fireEvent.click(within(mine).getByTestId("template-delete"));
    expect((await screen.findByTestId("template-delete-published-note")).textContent).toMatch(/public copy stays in the catalog/);
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("template-delete-published-note")).toBeNull());
    fireEvent.click(within(installed).getByTestId("template-delete"));
    await screen.findByTestId("template-delete-confirm");
    expect(screen.queryByTestId("template-delete-published-note")).toBeNull();
  });

  // A11 fix round 1 (Important 1): the creator's only takedown path must not hide behind the empty state.
  it("with no local template, a template this key published still shows in Your templates, with Hide — not the empty state", async () => {
    const CLOUD = "cccccccccccccccccccc";
    mineAnswer = {
      nickname: "nadav",
      templates: [{ id: CLOUD, name: "From my laptop", version: 1, hidden: false, moderated: false, indexPending: false, usesTotal: 5, uses7d: 2, byDay: {}, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" }],
    };
    fetchMock.mockResolvedValue(ok([]));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("templates-table-row")).toHaveLength(1));
    const row = screen.getByTestId("templates-table-row");
    expect(row.getAttribute("data-cloud-id")).toBe(CLOUD);
    expect(screen.getByRole("button", { name: "Hide" })).toBeTruthy();
    expect(screen.getByTestId("templates-table-not-here")).toBeTruthy();
    expect(screen.queryByTestId("templates-empty")).toBeNull();
  });

  // C4: the statement of reasons (Terms §11) — the card's note names the reason, the table's row adds How to dispute.
  it("a template we took down with a stated reason: the card and the table's row name it, with its date and How to dispute (the same component)", async () => {
    const MOD = "mmmmmmmmmmmmmmmmmmmm";
    const at = "2026-09-30T10:00:00.000Z";
    mineAnswer = {
      nickname: "nadav",
      templates: [{ id: MOD, name: MOD, version: 1, hidden: true, moderated: true, indexPending: false, usesTotal: 0, uses7d: 0, byDay: {}, createdAt: at, updatedAt: at, moderation: { reason: "copyright", note: "DMCA notice", at } }],
    };
    fetchMock.mockResolvedValue(ok([summary({ id: "t1", cloudId: MOD, name: "Taken down" })]));
    mount();
    const note = await screen.findByTestId("template-card-moderated");
    expect(note.textContent).toBe("Edits stay on this machine: the catalog won't take a new version of a moderated template.");
    // The card carries the catalog status itself — reason, date, How to dispute — as the table's row does (final review F10/F12).
    const card = within(screen.getByTestId("template-card-catalog"));
    expect(card.getByTestId("visibility-removed").textContent).toBe("Removed — Copyright");
    expect(card.getByTestId("visibility-removed-date").textContent).toBe("on 30 Sep 2026 (UTC)");
    expect(card.getByTestId("visibility-dispute").getAttribute("href")).toMatch(/\/terms#copyright$/);
    cleanup();
    search = "view=list";
    mount();
    const row = await screen.findByTestId(`template-visibility-${MOD}`);
    expect(within(row).getByTestId("visibility-removed").textContent).toBe("Removed — Copyright");
    expect(within(row).getByTestId("visibility-dispute").getAttribute("href")).toMatch(/\/terms#copyright$/);
  });

  // A16 (site final review Minor 2): the site answers a listing edit of a moderated template 403 `moderated`.
  it("a template moderation hid: the card and the table say so in libi's words, and its local edit stays on", async () => {
    const MOD = "mmmmmmmmmmmmmmmmmmmm";
    const PUB = "pppppppppppppppppppp";
    const entry = (id: string, moderated: boolean) => ({ id, name: id, version: 1, hidden: moderated, moderated, indexPending: false, usesTotal: 0, uses7d: 0, byDay: {}, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" });
    mineAnswer = { nickname: "nadav", templates: [entry(MOD, true), entry(PUB, false)] };
    fetchMock.mockResolvedValue(ok([summary({ id: "t1", cloudId: MOD, name: "Taken down" }), summary({ id: "t2", cloudId: PUB, name: "Still public" })]));
    mount();
    await waitFor(() => expect(screen.getByTestId("template-card-moderated")).toBeTruthy());
    const [modCard] = screen.getAllByTestId("template-card");
    expect(modCard.getAttribute("data-template-id")).toBe("t1");
    const note = within(modCard).getByTestId("template-card-moderated");
    expect(note.textContent).toBe("Edits stay on this machine: the catalog won't take a new version of a moderated template.");
    // No stated reason: "Hidden by moderation", in libi's words (its title), and no control.
    expect(within(modCard).getByTestId(`template-visibility-${MOD}`).querySelector("[title]")?.getAttribute("title")).toBe(MODERATED_MESSAGE);
    expect(within(within(modCard).getByTestId(`template-visibility-${MOD}`)).queryByRole("button")).toBeNull();
    // Moderation hides the catalog's copy, not the user's own: editing it here stays possible.
    const edit = within(modCard).getByTestId("template-edit");
    expect((edit as HTMLButtonElement).disabled).toBe(false);
    expect(edit.getAttribute("aria-describedby")).toBe(note.id);
    fireEvent.click(edit);
    await waitFor(() => expect(openWith).toHaveBeenCalledWith(expect.stringContaining("(id t1)")));
    openWith.mockClear();
    // The table's row (List view) says so too, with no control.
    cleanup();
    search = "view=list";
    mount();
    await screen.findByTestId(`template-visibility-${MOD}`);
    expect(screen.getByTestId(`template-visibility-${MOD}`).querySelector("[title]")?.getAttribute("title")).toBe(MODERATED_MESSAGE);
    expect(within(screen.getByTestId(`template-visibility-${MOD}`)).queryByRole("button")).toBeNull();
    cleanup();
    search = "";
    mount();
    await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(2));
    const pubCard = screen.getAllByTestId("template-card")[1];
    // A published template moderation did not touch keeps its edit — and its card offers Hide, as the List view's row does (final review F10).
    expect(within(pubCard).queryByTestId("template-card-moderated")).toBeNull();
    expect(within(pubCard).getByTestId(`template-visibility-${PUB}`).getAttribute("data-state")).toBe("public");
    expect(within(pubCard).getByRole("button", { name: "Hide" }).className).toContain("cursor-pointer");
    const pubEdit = within(pubCard).getByTestId("template-edit");
    expect((pubEdit as HTMLButtonElement).disabled).toBe(false);
    expect(pubEdit.getAttribute("aria-describedby")).toBeNull();
    fireEvent.click(pubEdit);
    await waitFor(() => expect(openWith).toHaveBeenCalledWith(expect.stringContaining("(id t2)")));
  });

  // A11 fix round 1: the spec's "refresh when the Templates page opens and every 10 min while open" — any tab.
  it("opening the page on the Mine tab refreshes the catalog, and again every 10 minutes while it stays open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      fetchMock.mockResolvedValue(ok([summary({})]));
      mount();
      await waitFor(() => expect(catalogGets).toHaveBeenCalledTimes(1));
      expect(screen.queryByTestId("public-tab")).toBeNull();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      });
      await waitFor(() => expect(catalogGets).toHaveBeenCalledTimes(2));
    } finally {
      vi.useRealTimers();
    }
  });

  // A11 fix round 1 (Minor 5): the cached list is not held back by a catalog refresh in flight.
  it("the public tab shows the cached cards while the catalog refresh is still in flight — skeletons only with no copy", async () => {
    search = "tab=public";
    catalog = new Promise(() => {}); // the refresh never answers during this test
    fetchMock.mockImplementation((url: string) => Promise.resolve(ok(String(url).includes("scope=public") ? [publicEntry()] : [])));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("public-card")).toHaveLength(1));
    expect(screen.queryByTestId("templates-grid-skeleton")).toBeNull();
    expect(screen.getByTestId("public-status-skeleton")).toBeTruthy();
    cleanup();
    // No copy at all yet: the skeleton, not an empty or offline claim.
    fetchMock.mockImplementation((url: string) => Promise.resolve(ok(String(url).includes("scope=public") ? [] : [])));
    mount();
    await waitFor(() => expect(screen.getByTestId("templates-grid-skeleton")).toBeTruthy());
    expect(screen.queryByTestId("public-tab-empty")).toBeNull();
    expect(screen.queryByTestId("public-offline")).toBeNull();
  });

  it("the public tab keeps the cached cards when libi's catalog route fails, and says the copy wasn't checked", async () => {
    search = "tab=public";
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string, init?: RequestInit) =>
        String(url) === "/api/templates/cloud/catalog" ? Promise.resolve({ ok: false, status: 500, json: async () => ({}) }) : routedFetch(url, init),
      ),
    );
    fetchMock.mockImplementation((url: string) => Promise.resolve(ok(String(url).includes("scope=public") ? [publicEntry()] : [])));
    mount();
    await waitFor(() => expect(screen.getByTestId("public-status").textContent).toContain("Couldn't check the catalog for updates"));
    expect(screen.getAllByTestId("public-card")).toHaveLength(1);
    expect(screen.queryByTestId("public-error")).toBeNull();
  });

  it("the public tab lists the catalog's cards from the public scope, under the catalog's media base", async () => {
    search = "tab=public";
    fetchMock.mockImplementation((url: string) => Promise.resolve(ok(String(url).includes("scope=public") ? [publicEntry()] : [summary({})])));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("public-card")).toHaveLength(1));
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes("scope=public"))).toBe(true);
    expect((screen.getByTestId("public-card-poster") as HTMLImageElement).src).toBe(`${BASE}templates/${PUBLIC_ID}/v1/poster.jpg`);
    expect(screen.getByTestId("public-status").textContent).toContain("Catalog updated");
    // Mine's cards and table are not on this tab.
    expect(screen.queryByTestId("template-card")).toBeNull();
    expect(screen.queryByTestId("templates-table")).toBeNull();
  });

  it("offline with no copy says the catalog can't be reached — not that there are no templates — and Refresh forces a fetch", async () => {
    search = "tab=public";
    catalog = { entries: [], fetchedAt: null, base: BASE, refreshed: false, error: "unreachable" };
    fetchMock.mockResolvedValue(ok([]));
    mount();
    await waitFor(() => expect(screen.getByTestId("public-offline")).toBeTruthy());
    expect(screen.queryByTestId("public-tab-empty")).toBeNull();
    expect(screen.getByTestId("public-offline").textContent).toContain("Can't reach the catalog right now");
    // Never the raw code.
    expect(document.body.textContent).not.toContain("unreachable");
    fireEvent.click(screen.getByTestId("public-refresh"));
    await waitFor(() => expect(catalogPosts).toHaveBeenCalledTimes(1));
  });

  it("offline with a copy keeps the cards and says how old they are, in words", async () => {
    search = "tab=public";
    catalog = { entries: [], fetchedAt: new Date(Date.now() - 3 * 3600_000).toISOString(), base: BASE, refreshed: false, error: "invalid_index" };
    fetchMock.mockResolvedValue(ok([publicEntry()]));
    mount();
    await waitFor(() => expect(screen.getAllByTestId("public-card")).toHaveLength(1));
    const status = screen.getByTestId("public-status").textContent ?? "";
    expect(status).toContain("The catalog sent a list libi couldn't read");
    expect(status).toContain("showing the copy from 3h ago");
    expect(status).not.toContain("invalid_index");
  });

  it("an empty catalog that answered is the empty state", async () => {
    search = "tab=public";
    fetchMock.mockResolvedValue(ok([]));
    mount();
    await waitFor(() => expect(screen.getByTestId("public-tab-empty")).toBeTruthy());
    expect(screen.queryByTestId("public-offline")).toBeNull();
  });
  // A-F live check N1 (2026-09-26): right after the user's own publish the Public tab said "No public
  // templates yet" until Refresh. The catalog route now names the change; the tab shows the template
  // from /mine (and the local poster) until the copy lists it — in production, up to the edge's 5 minutes.
  describe("the user's own change the catalog copy doesn't show yet", () => {
    const OWN = "oooooooooooooooooooo";
    const at = "2026-09-26T00:00:00.000Z";
    const ownMine = { id: OWN, name: "My fresh hook", version: 1, hidden: false, moderated: false, indexPending: false, usesTotal: 0, uses7d: 0, byDay: {}, createdAt: at, updatedAt: at };

    it("a template just published shows from /mine with the note — never 'No public templates yet' — and links both pages", async () => {
      search = "tab=public";
      catalog = { entries: [], fetchedAt: at, base: BASE, refreshed: false, ownChanges: [{ cloudId: OWN, version: 1, kind: "published", at }] };
      mineAnswer = { nickname: "nadav", templates: [ownMine] };
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(ok(String(url).includes("scope=public") ? [] : [summary({ id: "t-own", cloudId: OWN, name: "Local name", hasPoster: true, poster: "/api/templates/t-own/media/poster.jpg" })])),
      );
      mount();
      const item = await screen.findByTestId("public-just-listed-item");
      expect(item.getAttribute("data-cloud-id")).toBe(OWN);
      expect(item.textContent).toContain("My fresh hook");
      expect(within(item).getByTestId("public-just-listed-note").textContent).toBe("Just published — the catalog may take a few minutes to list it.");
      expect(within(item).getByRole("link", { name: "Open your template" }).getAttribute("href")).toBe("/templates/t-own");
      expect(within(item).getByRole("link", { name: "Public page" }).getAttribute("href")).toBe(`/templates/public/${OWN}`);
      expect(item.querySelector("img")?.getAttribute("src")).toMatch(/^\/api\/templates\/t-own\/media\/poster\.jpg\?v=/);
      expect(screen.queryByTestId("public-tab-empty")).toBeNull();
    });

    it("beside other cards it sits above them; once the copy lists it, it is an ordinary card", async () => {
      search = "tab=public";
      catalog = { entries: [], fetchedAt: at, base: BASE, refreshed: false, ownChanges: [{ cloudId: OWN, version: 1, kind: "shown", at }] };
      mineAnswer = { nickname: "nadav", templates: [ownMine] };
      fetchMock.mockImplementation((url: string) => Promise.resolve(ok(String(url).includes("scope=public") ? [publicEntry()] : [])));
      mount();
      await waitFor(() => expect(screen.getAllByTestId("public-card")).toHaveLength(1));
      expect((await screen.findByTestId("public-just-listed-note")).textContent).toBe("Public again — the catalog may take a few minutes to list it.");
      cleanup();
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(ok(String(url).includes("scope=public") ? [publicEntry(), publicEntry({ cloudId: OWN, name: "My fresh hook", poster: null, video: null })] : [])),
      );
      mount();
      await waitFor(() => expect(screen.getAllByTestId("public-card")).toHaveLength(2));
      expect(screen.queryByTestId("public-just-listed")).toBeNull();
    });

    it("a template just hidden leaves the Public tab at once, though the copy still lists it", async () => {
      search = "tab=public";
      catalog = { entries: [], fetchedAt: at, base: BASE, refreshed: false, ownChanges: [{ cloudId: PUBLIC_ID, version: 1, kind: "hidden", at }] };
      fetchMock.mockImplementation((url: string) => Promise.resolve(ok(String(url).includes("scope=public") ? [publicEntry()] : [])));
      mount();
      await waitFor(() => expect(screen.getByTestId("public-tab-empty")).toBeTruthy());
      expect(screen.queryByTestId("public-card")).toBeNull();
    });
  });

  // D2: one view with a Cards / List switch.
  describe("Cards / List", () => {
    const CLOUD = "cccccccccccccccccccc";
    const mineEntry = (id: string, name: string) => ({ id, name, version: 1, hidden: false, moderated: false, indexPending: false, usesTotal: 5, uses7d: 2, byDay: {}, createdAt: "2026-09-23T00:00:00.000Z", updatedAt: "2026-09-23T00:00:00.000Z" });

    it("?view=list renders the table — headed Your templates — and not the grid", async () => {
      search = "view=list";
      fetchMock.mockResolvedValue(ok([summary({}), summary({ id: "t2", name: "Hook" })]));
      mount();
      await waitFor(() => expect(screen.getAllByTestId("templates-table-row")).toHaveLength(2));
      expect(screen.queryByTestId("templates-grid")).toBeNull();
      expect(screen.queryByTestId("template-card")).toBeNull();
      expect(screen.getByRole("heading", { name: "Your templates" })).toBeTruthy();
      expect(screen.getByTestId("templates-view-list").getAttribute("aria-pressed")).toBe("true");
    });

    it("the list view's loading state mirrors the table, not the grid", async () => {
      search = "view=list";
      fetchMock.mockImplementation(() => new Promise(() => {}));
      mount();
      expect(screen.getByTestId("templates-table-skeleton")).toBeTruthy();
      expect(screen.queryByTestId("templates-grid-skeleton")).toBeNull();
    });

    it("the switch swaps the view in place", async () => {
      fetchMock.mockResolvedValue(ok([summary({})]));
      mount();
      await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
      fireEvent.click(screen.getByTestId("templates-view-list"));
      await waitFor(() => expect(screen.getAllByTestId("templates-table-row")).toHaveLength(1));
      expect(screen.queryByTestId("templates-grid")).toBeNull();
    });

    it("published templates with no local copy: Cards says so and its link opens List, where they are rows", async () => {
      mineAnswer = { nickname: "nadav", templates: [mineEntry(CLOUD, "From my laptop"), mineEntry("pppppppppppppppppppp", "Mine, here")] };
      fetchMock.mockResolvedValue(ok([summary({ cloudId: "pppppppppppppppppppp", name: "Mine, here" })]));
      mount();
      const note = await screen.findByTestId("templates-cloud-only-note");
      expect(note.textContent).toContain("1 published template isn't on this machine");
      fireEvent.click(within(note).getByRole("button"));
      await waitFor(() => expect(screen.getAllByTestId("templates-table-row")).toHaveLength(2));
      expect(screen.getByTestId("templates-table-not-here")).toBeTruthy();
    });

    it("\"Your templates\" heads the Mine tab in Cards view too — the name Terms §11 gives it", async () => {
      fetchMock.mockResolvedValue(ok([summary({})]));
      mount();
      await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
      expect(screen.getByTestId("templates-view-cards").getAttribute("aria-pressed")).toBe("true");
      expect(screen.getByRole("heading", { name: "Your templates" })).toBeTruthy();
      fireEvent.click(screen.getByTestId("templates-view-list"));
      await waitFor(() => expect(screen.getAllByTestId("templates-table-row")).toHaveLength(1));
      expect(screen.getByRole("heading", { name: "Your templates" })).toBeTruthy();
    });

    it("Cards: a search that matches only a template published from elsewhere points at it, not at 'No template matches' (review M7)", async () => {
      mineAnswer = { nickname: "nadav", templates: [mineEntry(CLOUD, "Laptop hook")] };
      fetchMock.mockImplementation((url: string) => Promise.resolve(ok(String(url).includes("q=laptop") ? [] : [summary({})])));
      mount();
      await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
      fireEvent.change(screen.getByTestId("list-search"), { target: { value: "laptop" } });
      await waitFor(() => expect(screen.getByTestId("templates-no-local-match")).toBeTruthy());
      expect(screen.queryByTestId("templates-no-match")).toBeNull();
      expect(screen.getByTestId("templates-cloud-only-note").textContent).toContain("1 published template isn't on this machine");
      expect(screen.getByRole("heading", { name: "Your templates" })).toBeTruthy();
    });

    it("Cards: the note says when one of those was removed by moderation — List view has its reason and How to dispute", async () => {
      const at = "2026-09-24T00:00:00.000Z";
      mineAnswer = {
        nickname: "nadav",
        templates: [
          { ...mineEntry(CLOUD, "Taken down"), hidden: true, moderated: true, moderation: { reason: "reports", note: null, at } },
          mineEntry("dddddddddddddddddddd", "Elsewhere"),
        ],
      };
      fetchMock.mockResolvedValue(ok([summary({})]));
      mount();
      const note = await screen.findByTestId("templates-cloud-only-note");
      expect(note.textContent).toContain("2 published templates aren't on this machine — see them in List view. 1 of them was removed from the catalog: List view says why, and how to dispute it.");
      fireEvent.click(within(note).getByRole("button"));
      await waitFor(() => expect(screen.getByTestId("visibility-removed")).toBeTruthy());
      expect(screen.getByTestId("visibility-removed").textContent).toBe("Hidden after reports — pending review");
    });

    it("before the stored view can be read (the server render), neither the grid nor the table skeleton is drawn (review M8)", () => {
      window.localStorage.setItem("libi:templates-view", "list");
      fetchMock.mockImplementation(() => new Promise(() => {}));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
      const html = renderToString(
        <QueryClientProvider client={client}>
          <TemplatesPage />
        </QueryClientProvider>,
      );
      expect(html).toContain("templates-view-pending");
      expect(html).not.toContain("templates-grid-skeleton");
      expect(html).not.toContain("templates-table-skeleton");
    });

    it("no note when every published template is here", async () => {
      mineAnswer = { nickname: "nadav", templates: [mineEntry("pppppppppppppppppppp", "Mine, here")] };
      fetchMock.mockResolvedValue(ok([summary({ cloudId: "pppppppppppppppppppp", name: "Mine, here" })]));
      mount();
      await waitFor(() => expect(screen.getAllByTestId("template-card")).toHaveLength(1));
      await waitFor(() => expect(screen.getByTestId("publishing-as-edit")).toBeTruthy());
      expect(screen.queryByTestId("templates-cloud-only-note")).toBeNull();
    });

    it("the toolbar filters the list view too — and a filtered-out local template never reads as 'Not on this machine'", async () => {
      search = "view=list";
      mineAnswer = { nickname: "nadav", templates: [mineEntry("pppppppppppppppppppp", "Published hook")] };
      fetchMock.mockImplementation((url: string) =>
        Promise.resolve(
          ok(
            String(url).includes("q=lower")
              ? [summary({})]
              : [summary({}), summary({ id: "t2", name: "Published hook", cloudId: "pppppppppppppppppppp" })],
          ),
        ),
      );
      mount();
      await waitFor(() => expect(screen.getAllByTestId("templates-table-row")).toHaveLength(2));
      fireEvent.change(screen.getByTestId("list-search"), { target: { value: "lower" } });
      await waitFor(() => expect(screen.getAllByTestId("templates-table-row")).toHaveLength(1));
      expect(screen.getByTestId("templates-table-row").getAttribute("data-template-id")).toBe("t1");
      expect(screen.queryByTestId("templates-table-not-here")).toBeNull();
    });

    it("the public tab has the switch too: List is the catalog as a table", async () => {
      search = "tab=public&view=list";
      fetchMock.mockImplementation((url: string) => Promise.resolve(ok(String(url).includes("scope=public") ? [publicEntry()] : [])));
      mount();
      await waitFor(() => expect(screen.getAllByTestId("public-templates-table-row")).toHaveLength(1));
      expect(screen.queryByTestId("public-grid")).toBeNull();
      fireEvent.click(screen.getByTestId("templates-view-cards"));
      await waitFor(() => expect(screen.getAllByTestId("public-card")).toHaveLength(1));
      expect(screen.queryByTestId("public-templates-table")).toBeNull();
    });
  
    it("Cards: Hide on a published template's card hides it — the same action as the List view's row (final review F10)", async () => {
      mineAnswer = { nickname: "nadav", templates: [mineEntry("pppppppppppppppppppp", "Mine, here")] };
      fetchMock.mockResolvedValue(ok([summary({ cloudId: "pppppppppppppppppppp", name: "Mine, here" })]));
      const sent: unknown[] = [];
      const base = vi.mocked(fetch).getMockImplementation()!;
      vi.mocked(fetch).mockImplementation(((url: string, init?: RequestInit) => {
        if (String(url) === "/api/templates/cloud/visibility") {
          sent.push(JSON.parse(String(init?.body)));
          return Promise.resolve(json({ ok: true, template: { ...mineEntry("pppppppppppppppppppp", "Mine, here"), hidden: true } }));
        }
        return base(url, init);
      }) as never);
      mount();
      const card = await screen.findByTestId("template-card-catalog");
      fireEvent.click(await within(card).findByRole("button", { name: "Hide" }));
      await waitFor(() => expect(sent).toEqual([{ cloudId: "pppppppppppppppppppp", hidden: true }]));
    });
  });
});
