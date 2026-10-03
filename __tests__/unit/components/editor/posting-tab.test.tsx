// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render as tlRender, renderHook, screen, waitFor, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { SocialPost } from "@/lib/social/types";
import type { PiecePost } from "@/lib/queries/social";

vi.mock("@/lib/analytics/client", () => ({ trackEvent: vi.fn() }));

vi.mock("@/components/social/ask-agent-button", () => ({
  AskAgentButton: ({ kind, label }: { kind: string; label?: string }) => (
    <button data-testid={`ask-agent-${kind}`}>{label ?? "Ask the agent"}</button>
  ),
}));

vi.mock("@/components/social/analytics-panel", () => ({
  AnalyticsPanel: ({ postId }: { postId: string }) => <div data-testid={`analytics-${postId}`}>analytics for {postId}</div>,
}));

vi.mock("@/components/social/post-detail-sheet", () => ({
  PostDetailSheet: ({ postId }: { postId: string | null }) =>
    postId ? <div data-testid="detail-sheet">{postId}</div> : null,
}));

type ComposerStubProps = {
  intent: { pieceId: string; pieceName: string; exportPath: string | null; draftPostId: string | null };
  exports?: Array<{ filePath: string; exportId?: string; name?: string; aspect?: string }>;
  awaitedExport?: { id: string; status: string } | null;
  onExportRequested: () => void;
  onAwaitedHandled?: () => void;
  onDone: (postId: string | null) => void;
};
let lastComposerProps: ComposerStubProps | null = null;
vi.mock("@/components/social/composer/composer", () => ({
  Composer: (props: ComposerStubProps) => {
    lastComposerProps = props;
    return (
      <div data-testid="composer-stub">
        exportPath:{props.intent.exportPath ?? "none"} draftPostId:{props.intent.draftPostId ?? "none"}
        <span data-testid="stub-exports">{(props.exports ?? []).map((e) => e.name).join(",")}</span>
        <span data-testid="stub-awaited">{props.awaitedExport ? `${props.awaitedExport.id}:${props.awaitedExport.status}` : "none"}</span>
        <button data-testid="stub-export-requested" onClick={props.onExportRequested} />
        <button data-testid="stub-awaited-handled" onClick={props.onAwaitedHandled} />
      </div>
    );
  },
}));

import { PostingTab } from "@/components/editor/posting-tab";
import type { ExportRecordView } from "@/lib/exports/types";
import { trackEvent } from "@/lib/analytics/client";
import {
  consumePostingIntent,
  openPostingTab,
  subscribeExportDialogRequest,
  takeExportDialogDraftPostId,
  takeExportDialogPurpose,
  takeExportDialogReturnToPost,
  usePostingIntent,
} from "@/hooks/social/use-posting-intent";

function post(overrides: Partial<SocialPost> = {}): PiecePost {
  const base: SocialPost = {
    id: "post_1",
    status: "draft",
    content: "hello",
    createdAt: "2026-09-20T09:00:00.000Z",
    media: [{ url: "https://cdn.example/e.mp4", type: "video" }],
    targets: [
      { platform: "instagram", accountId: "acct-ig", status: "pending", options: { platform: "instagram", instagram: { contentType: "reel" } } },
    ],
    tags: [],
  };
  return {
    ...base,
    ...overrides,
    link: {
      providerId: "zernio",
      providerPostId: overrides.id ?? base.id,
      pieceId: "p1",
      exportPath: null,
      requestId: null,
      createdBy: "ui",
      createdAt: "2026-09-20T09:00:00.000Z",
      lastStatus: null,
      lastStatusAt: null,
    },
  };
}

function jsonResponse(body: unknown, init?: { status?: number }): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

const CONNECTED_STATUS = {
  providerId: "zernio",
  connected: true,
  needsReconnect: false,
  scopes: [],
  catalog: [],
  settings: { providerId: "zernio", timezone: "Asia/Bangkok", defaults: { instagramType: "reel", aiLabel: true }, pollSeconds: 30 },
};

describe("PostingTab", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  /** The piece's copyrighted songs, as `GET /api/pieces/:id/audio-rights` answers. */
  let pieceCopyrighted: Array<{ fileId: string; name: string; clipSeconds: number }> = [];

  beforeEach(() => {
    lastComposerProps = null;
    pieceCopyrighted = [];
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("/api/social/status")) return jsonResponse(CONNECTED_STATUS);
      if (url.startsWith("/api/social/pieces/p1/posts")) {
        return jsonResponse({
          posts: [
            post({ id: "post_1", status: "draft" }),
            // One post per platform, so the filters have something real to
            // narrow: a filter tested against a single-platform list proves
            // only that it does not crash.
            post({
              id: "post_2",
              status: "published",
              targets: [{ platform: "tiktok", accountId: "acct-tt", status: "published" }],
            }),
          ],
        });
      }
      if (url.startsWith("/api/pieces/p1/audio-rights")) return jsonResponse({ copyrighted: pieceCopyrighted, ownMusic: [] });
      if (url.startsWith("/api/pieces/p1/exports")) return jsonResponse({ exports: [] });
      if (url.startsWith("/api/pieces/p1")) return jsonResponse({ id: "p1", name: "My Piece" });
      if (url.startsWith("/api/jobs")) return jsonResponse({ jobs: [] });
      return jsonResponse({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    // The posting-intent store is a globalThis singleton — clear it so one
    // test's openPostingTab() call can't leak into the next test's mount.
    consumePostingIntent();
  });

  function renderTab(pieceId = "p1") {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return tlRender(
      <QueryClientProvider client={qc}>
        <PostingTab pieceId={pieceId} />
      </QueryClientProvider>,
    );
  }

  it("renders the never-connected empty state ABOVE the composer, and does not render the composer", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("/api/social/status")) {
        return jsonResponse({ ...CONNECTED_STATUS, connected: false, needsReconnect: false });
      }
      if (url.startsWith("/api/pieces/p1/audio-rights")) return jsonResponse({ copyrighted: [], ownMusic: [] });
      if (url.startsWith("/api/pieces/p1/exports")) return jsonResponse({ exports: [] });
      if (url.startsWith("/api/pieces/p1")) return jsonResponse({ id: "p1", name: "My Piece" });
      return jsonResponse({}, { status: 404 });
    });
    renderTab();
    await waitFor(() => expect(screen.getByTestId("social-connect-libi")).toBeInTheDocument());
    expect(screen.queryByTestId("composer-stub")).toBeNull();
    // Never fetched the piece's posts while not connected.
    expect(fetchMock.mock.calls.some(([u]) => String(u).includes("/pieces/p1/posts"))).toBe(false);
  });

  it("connected: opens on this piece's posts (no piece chip) with inline analytics for the published one", async () => {
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
    // The published post gets inline analytics; the draft does not.
    expect(screen.getByTestId("analytics-post_2")).toBeInTheDocument();
    expect(screen.queryByTestId("analytics-post_1")).toBeNull();
    // A piece that HAS posts opens on them. The composer is five steps tall;
    // stacked under the history it pushed the posts off screen and made every
    // visit read as "make another one".
    expect(screen.queryByTestId("composer-stub")).toBeNull();
  });

  it("New post swaps to the composer, and there is always a way back", async () => {
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
    fireEvent.click(screen.getByTestId("posting-view-new"));
    await waitFor(() => expect(screen.getByTestId("composer-stub")).toBeInTheDocument());
    expect(screen.queryAllByTestId("post-row")).toHaveLength(0);
    fireEvent.click(screen.getByTestId("posting-back-to-posts"));
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
  });

  it("filters this piece's posts by platform and by type", async () => {
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
    expect(screen.getByTestId("posting-filter-count")).toHaveTextContent("2 of 2");
    fireEvent.change(screen.getByTestId("posting-filter-platform"), { target: { value: "tiktok" } });
    await waitFor(() => expect(screen.getByTestId("posting-filter-count")).toHaveTextContent("1 of 2"));
    // The total stays on screen, so a narrowed list never reads as a piece
    // that lost its posts.
    expect(screen.getAllByTestId("post-row")).toHaveLength(1);
    fireEvent.change(screen.getByTestId("posting-filter-platform"), { target: { value: "" } });
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
  });

  it("renders one header line — the title, the count, and the link to Social", async () => {
    renderTab();
    // The count lives in the title. It used to sit on a tab row of its own
    // below it: a whole line of chrome for a strip with one tab in it.
    await waitFor(() => expect(screen.getByText(/Posts \(2\)/)).toBeInTheDocument());
    expect(screen.queryByTestId("posting-views")).toBeNull();
    const link = screen.getByRole("link", { name: /See everything in Social/ });
    expect(link).toHaveAttribute("href", "/social?tab=posts");
  });

  it("fires social_posting_tab_viewed exactly once on mount", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId("composer-stub")).toBeInTheDocument());
    const calls = (trackEvent as unknown as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[0] === "social_posting_tab_viewed");
    expect(calls).toHaveLength(1);
  });

  it("openPostingTab({ pieceId, providerPostId }) mounts the composer in edit mode for that draft", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId("composer-stub")).toBeInTheDocument());
    openPostingTab({ pieceId: "p1", providerPostId: "post_1" });
    await waitFor(() => expect(lastComposerProps?.intent.draftPostId).toBe("post_1"));
  });
  /**
   * QA 2026-09-22: the Social page's "Piece" button lands HERE, on the one
   * post it came from — handed over before the tab mounts (the editor's
   * `?piece=&post=` deep link), so it must be read at mount, and it must open
   * the list, never the composer.
   */
  it("a focus hand-off opens the list narrowed to that one post, with a way back to all of them", async () => {
    openPostingTab({ pieceId: "p1", focusPostId: "post_2" });
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(1));
    expect(screen.getByTestId("post-row")).toHaveAttribute("data-post-id", "post_2");
    expect(screen.getByTestId("posting-focus-chip")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-stub")).toBeNull();

    fireEvent.click(screen.getByTestId("posting-focus-clear"));
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
    expect(screen.queryByTestId("posting-focus-chip")).toBeNull();
  });

  it("a focus hand-off that arrives while the tab is open narrows the list too", async () => {
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
    openPostingTab({ pieceId: "p1", focusPostId: "post_1" });
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(1));
    expect(screen.getByTestId("post-row")).toHaveAttribute("data-post-id", "post_1");
  });

  it("names every card by its network and type, in the list beside them", async () => {
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
    const names = screen.getAllByTestId("post-nav-item").map((b) => b.textContent);
    // The network AND the type. Two of a piece's posts usually carry the same
    // caption, so the caption cannot be what tells them apart in a list.
    expect(names[0]).toContain("Instagram — Reel");
    expect(names[1]).toContain("TikTok — Video");
    // The first card is the one highlighted before any scroll has happened —
    // jsdom has no IntersectionObserver, and the list must still be usable.
    expect(screen.getAllByTestId("post-nav-item")[0]).toHaveAttribute("data-active", "true");
  });

  it("clicking a name in the list scrolls to that card", async () => {
    const scrollIntoView = vi.fn();
    // jsdom implements no scrolling at all, so the real method is absent.
    Element.prototype.scrollIntoView = scrollIntoView;
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
    fireEvent.click(screen.getAllByTestId("post-nav-item")[1]);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(screen.getAllByTestId("post-nav-item")[1]).toHaveAttribute("data-active", "true");
  });

  it("a post the composer just sent is scrolled into view — where its TikTok draft says how to finish", async () => {
    const scrolled: Element[] = [];
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this);
    };
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
    fireEvent.click(screen.getByTestId("posting-view-new"));
    await waitFor(() => expect(lastComposerProps).not.toBeNull());
    act(() => lastComposerProps!.onDone("post_2"));
    await waitFor(() => expect(scrolled.map((e) => e.getAttribute("data-post-id"))).toEqual(["post_2"]));
  });

  it("a draft's Edit button opens the composer on that draft", async () => {
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
    // Only the draft has one: a published post has nothing left to edit.
    const edits = screen.getAllByTestId("post-action-edit");
    expect(edits).toHaveLength(1);
    fireEvent.click(edits[0]);
    await waitFor(() => expect(screen.getByTestId("composer-stub")).toBeInTheDocument());
    expect(lastComposerProps?.intent.draftPostId).toBe("post_1");
    // And the way back is still there — editing a draft is not a one-way door.
    expect(screen.getByTestId("posting-back-to-posts")).toBeInTheDocument();
  });

  it("a post's analytics live INSIDE its own card, not as a sibling block", async () => {
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
    const published = screen.getAllByTestId("post-row").find((el) => el.getAttribute("data-post-id") === "post_2");
    expect(published).toBeDefined();
    // The card CONTAINS the analytics. Rendered as a sibling <li>, ten posts
    // read as thirty unrelated panels (QA 2026-09-21).
    expect(published!.querySelector('[data-testid="analytics-post_2"]')).not.toBeNull();
    // …and a draft with no ads and no analytics grows no empty divider.
    const draft = screen.getAllByTestId("post-row").find((el) => el.getAttribute("data-post-id") === "post_1");
    expect(draft!.querySelector('[data-testid="post-row-detail"]')).toBeNull();
  });
  it("a published post's music line and its finish link live inside its card; a draft still grows no divider", async () => {
    pieceCopyrighted = [{ fileId: "f1", name: "espresso.mp3", clipSeconds: 12 }];
    const posts = [
      post({ id: "post_1", status: "draft" }),
      post({
        id: "post_2",
        status: "published",
        targets: [{ platform: "tiktok", accountId: "acct-tt", status: "published" }],
        libi: { pieceId: "p1", targetOptions: [{ platform: "tiktok", tiktok: {} as never, music: { mode: "draft" } }] },
      }),
    ];
    const base = fetchMock.getMockImplementation() as (input: RequestInfo | URL) => Promise<Response>;
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("/api/social/pieces/p1/posts")) return jsonResponse({ posts });
      return base(input);
    });
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(2));
    const published = screen.getAllByTestId("post-row").find((el) => el.getAttribute("data-post-id") === "post_2")!;
    await waitFor(() => expect(published.querySelector('[data-testid="post-music-tiktok-acct-tt"]')).not.toBeNull());
    expect(published.querySelector('[data-testid="post-music-tiktok-acct-tt"]')).toHaveTextContent("Draft to finish in the app");
    expect(published.querySelector('[data-testid="finish-link-tiktok-inbox"]')).toHaveAttribute("href", "https://www.tiktok.com/");
    const draft = screen.getAllByTestId("post-row").find((el) => el.getAttribute("data-post-id") === "post_1")!;
    expect(draft.querySelector('[data-testid="post-row-detail"]')).toBeNull();
  });
});


// ── The exports rework: what the composer is handed, and the round trip ─────────

const exportRecord = (id: string, over: Partial<ExportRecordView> = {}): ExportRecordView =>
  ({
    id: `exp_${id}`, pieceId: "p1", pieceName: "My Piece", jobId: null, name: id, fileName: `${id}.mp4`, path: `/s/p1/exports/${id}.mp4`,
    status: "done", missing: false, error: null, queuedAt: 1, startedAt: 1, completedAt: 100, sizeBytes: 1000, durationSec: 10,
    width: 1080, height: 1920, aspect: "9:16", container: "mp4", codec: "avc", fps: 30, quality: "source", graphicsQuality: null,
    purpose: "social", carriesCopyrighted: false, excludedFileIds: [], backend: null, droppedOverlays: null, source: "user",
    progress: null, waiting: null, ...over,
  }) as ExportRecordView;

describe("PostingTab — exports and the round trip from the composer", () => {
  let records: ExportRecordView[];
  let postsList: PiecePost[] = [];
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    postsList = [];
    records = [exportRecord("old", { completedAt: 100 }), exportRecord("new", { completedAt: 300 }), exportRecord("busy", { status: "running", completedAt: null, path: null })];
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("/api/social/status")) return jsonResponse(CONNECTED_STATUS);
      if (url.startsWith("/api/social/pieces/p1/posts")) return jsonResponse({ posts: postsList });
      if (url.startsWith("/api/pieces/p1/audio-rights")) return jsonResponse({ copyrighted: [], ownMusic: [] });
      if (url.startsWith("/api/pieces/p1/exports")) return jsonResponse({ exports: records });
      if (url.startsWith("/api/pieces/p1")) return jsonResponse({ id: "p1", name: "My Piece" });
      return jsonResponse({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    consumePostingIntent();
    takeExportDialogPurpose();
    takeExportDialogReturnToPost();
    takeExportDialogDraftPostId();
  });

  function renderTab() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return tlRender(
      <QueryClientProvider client={qc}>
        <PostingTab pieceId="p1" />
      </QueryClientProvider>,
    );
  }

  it("hands the composer every finished export (not the running one), newest first", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId("stub-exports")).toHaveTextContent("new,old"));
    expect(screen.getByTestId("stub-exports")).not.toHaveTextContent("busy");
  });

  it("'Post…' on an export starts the composer on exactly that file", async () => {
    openPostingTab({ pieceId: "p1", exportPath: "/s/p1/exports/old.mp4" });
    renderTab();
    await waitFor(() => expect(lastComposerProps?.intent.exportPath).toBe("/s/p1/exports/old.mp4"));
  });

  it("with no export asked for, the composer is not pinned to one", async () => {
    renderTab();
    await waitFor(() => expect(screen.getByTestId("stub-exports")).toHaveTextContent("new,old"));
    expect(lastComposerProps?.intent.exportPath).toBeNull();
  });

  it("the composer's Export for social asks for the dialog AND to come back to the post", async () => {
    const seen: string[] = [];
    const off = subscribeExportDialogRequest((id) => seen.push(id));
    renderTab();
    await waitFor(() => expect(screen.getByTestId("composer-stub")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("stub-export-requested"));
    off();
    expect(seen).toEqual(["p1"]);
    expect(takeExportDialogPurpose()).toBe("social");
    expect(takeExportDialogReturnToPost()).toBe(true);
  });

  it("an export started from the composer is handed over by its record while it renders, and as it finishes", async () => {
    openPostingTab({ pieceId: "p1", awaitExportId: "exp_busy" });
    renderTab();
    await waitFor(() => expect(screen.getByTestId("stub-awaited")).toHaveTextContent("exp_busy:running"));
    // The record finishes (the exports query is invalidated by the one SSE).
    records = records.map((r) => (r.id === "exp_busy" ? exportRecord("busy", { completedAt: 500 }) : r));
    // The exports query re-reads on its own interval (a couple of seconds), so the wait is the query's: await the outcome.
    await waitFor(() => expect(screen.getByTestId("stub-awaited")).toHaveTextContent("exp_busy:done"), { timeout: 8_000 });
    expect(screen.getByTestId("stub-exports")).toHaveTextContent("busy");
  }, 10_000);

  it("once the awaited export has settled the hand-off is spent: a remount does not announce it again", async () => {
    records = [exportRecord("busy", { completedAt: 500 })];
    openPostingTab({ pieceId: "p1", awaitExportId: "exp_busy" });
    const first = renderTab();
    await waitFor(() => expect(screen.getByTestId("stub-awaited")).toHaveTextContent("exp_busy:done"));
    first.unmount();
    renderTab();
    await waitFor(() => expect(screen.getByTestId("stub-exports")).toHaveTextContent("busy"));
    expect(screen.getByTestId("stub-awaited")).toHaveTextContent("none");
  });

  it("a failed awaited export is handed over as failed", async () => {
    records = [exportRecord("busy", { status: "failed", error: "boom", completedAt: null, path: null })];
    openPostingTab({ pieceId: "p1", awaitExportId: "exp_busy" });
    renderTab();
    await waitFor(() => expect(screen.getByTestId("stub-awaited")).toHaveTextContent("exp_busy:failed"));
  });
});

describe("PostingTab — hand-offs are spent once the composer has them", () => {
  let records: ExportRecordView[];
  beforeEach(() => {
    records = [exportRecord("old", { completedAt: 100 }), exportRecord("busy", { completedAt: 500 })];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.startsWith("/api/social/status")) return jsonResponse(CONNECTED_STATUS);
        if (url.startsWith("/api/social/pieces/p1/posts")) return jsonResponse({ posts: [post({ id: "post_1", status: "published" })] });
        if (url.startsWith("/api/pieces/p1/audio-rights")) return jsonResponse({ copyrighted: [], ownMusic: [] });
        if (url.startsWith("/api/pieces/p1/exports")) return jsonResponse({ exports: records });
        if (url.startsWith("/api/pieces/p1")) return jsonResponse({ id: "p1", name: "My Piece" });
        return jsonResponse({}, { status: 404 });
      }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    consumePostingIntent();
    takeExportDialogPurpose();
    takeExportDialogReturnToPost();
    takeExportDialogDraftPostId();
  });
  function renderTab() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    return tlRender(
      <QueryClientProvider client={qc}>
        <PostingTab pieceId="p1" />
      </QueryClientProvider>,
    );
  }

  it("once the composer has taken the awaited export, the next composer in this visit is not handed it again", async () => {
    openPostingTab({ pieceId: "p1", awaitExportId: "exp_busy" });
    renderTab();
    await waitFor(() => expect(screen.getByTestId("stub-awaited")).toHaveTextContent("exp_busy:done"));
    fireEvent.click(screen.getByTestId("stub-awaited-handled")); // the composer adopted it
    await waitFor(() => expect(screen.getByTestId("stub-awaited")).toHaveTextContent("none"));
    // Back to the list and a fresh post: no second adoption, no repeated notice.
    fireEvent.click(await screen.findByTestId("posting-back-to-posts"));
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("posting-view-new"));
    await waitFor(() => expect(screen.getByTestId("composer-stub")).toBeInTheDocument());
    expect(screen.getByTestId("stub-awaited")).toHaveTextContent("none");
  });

  it("a Post… export starts the composer it opened, and no composer after it", async () => {
    openPostingTab({ pieceId: "p1", exportPath: "/s/p1/exports/old.mp4" });
    renderTab();
    await waitFor(() => expect(lastComposerProps?.intent.exportPath).toBe("/s/p1/exports/old.mp4"));
    fireEvent.click(await screen.findByTestId("posting-back-to-posts"));
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("posting-view-new"));
    await waitFor(() => expect(lastComposerProps?.intent.exportPath).toBeNull());
  });

  it("a draft hand-off is spent: after the user leaves and returns, the composer does not reopen that draft", async () => {
    // The agent (or Social's Edit draft) opens draft post_1…
    openPostingTab({ pieceId: "p1", providerPostId: "post_1" });
    const first = renderTab();
    await waitFor(() => expect(lastComposerProps?.intent.draftPostId).toBe("post_1"));
    first.unmount();
    // …it is published or deleted elsewhere, and the user comes back: a plain, new composer.
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(1));
    expect(screen.queryByTestId("composer-stub")).toBeNull();
    fireEvent.click(screen.getByTestId("posting-view-new"));
    await waitFor(() => expect(lastComposerProps?.intent.draftPostId).toBeNull());
  });

  it("a Post… export is spent the same way once the tab has been left", async () => {
    openPostingTab({ pieceId: "p1", exportPath: "/s/p1/exports/old.mp4" });
    const first = renderTab();
    await waitFor(() => expect(lastComposerProps?.intent.exportPath).toBe("/s/p1/exports/old.mp4"));
    first.unmount();
    renderTab();
    await waitFor(() => expect(screen.getAllByTestId("post-row")).toHaveLength(1));
    fireEvent.click(screen.getByTestId("posting-view-new"));
    await waitFor(() => expect(lastComposerProps?.intent.exportPath).toBeNull());
  });

  it("a hand-off whose export was deleted meanwhile is spent, and the composer is the normal one", async () => {
    records = [exportRecord("old", { completedAt: 100 })]; // exp_gone is not in the list
    openPostingTab({ pieceId: "p1", awaitExportId: "exp_gone" });
    renderTab();
    await waitFor(() => expect(screen.getByTestId("stub-exports")).toHaveTextContent("old"));
    expect(screen.getByTestId("stub-awaited")).toHaveTextContent("none");
    // Consumed: nothing is left in the store to hand to the next mount.
    await waitFor(() => expect(renderHook(() => usePostingIntent("p1")).result.current).toBeNull());
  });

  it("an export still rendering stays handed to the tab across a remount, and to a new post started meanwhile", async () => {
    records = [exportRecord("old", { completedAt: 100 }), exportRecord("busy", { status: "running", completedAt: null, path: null })];
    openPostingTab({ pieceId: "p1", awaitExportId: "exp_busy" });
    const first = renderTab();
    await waitFor(() => expect(screen.getByTestId("stub-awaited")).toHaveTextContent("exp_busy:running"));
    // + New post while it renders does not lose the in-flight panel.
    fireEvent.click(await screen.findByTestId("posting-back-to-posts"));
    fireEvent.click(await screen.findByTestId("posting-view-new"));
    await waitFor(() => expect(screen.getByTestId("composer-stub")).toBeInTheDocument());
    expect(screen.getByTestId("stub-awaited")).toHaveTextContent("exp_busy:running");
    first.unmount();
    renderTab();
    await waitFor(() => expect(screen.getByTestId("stub-awaited")).toHaveTextContent("exp_busy:running"));
  });

  it("the way back from the export dialog reopens the draft that was being edited", async () => {
    // Out: the composer editing a draft asks for the dialog…
    openPostingTab({ pieceId: "p1", providerPostId: "post_1" });
    const first = renderTab();
    await waitFor(() => expect(lastComposerProps?.intent.draftPostId).toBe("post_1"));
    fireEvent.click(screen.getByTestId("stub-export-requested"));
    expect(takeExportDialogDraftPostId()).toBe("post_1");
    first.unmount();
    // …and back: the dialog's Start returns with the same draft id, on a tab that has just mounted.
    openPostingTab({ pieceId: "p1", awaitExportId: "exp_busy", providerPostId: "post_1" });
    renderTab();
    await waitFor(() => expect(screen.getByTestId("composer-stub")).toHaveTextContent("draftPostId:post_1"));
    expect(screen.getByTestId("stub-awaited")).toHaveTextContent("exp_busy");
  });
});
