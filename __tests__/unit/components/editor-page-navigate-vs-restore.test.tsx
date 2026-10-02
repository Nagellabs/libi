// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

/**
 * The editor's "reopen the last piece" restore vs agent navigate events, on
 * the REAL page with its children stubbed. The restore waits for the pieces
 * list; a navigate event that lands before that list arrives decides whether
 * the restore still runs.
 *
 * - An event that OPENS a piece (the hand-off's parked `piece` event after Use
 *   on /templates) must win: the restore would otherwise overwrite it with the
 *   previously open piece.
 * - The finish toast's Open (`openExportInTab`) is such an event too: made from another page it
 *   is parked, then claimed as this page mounts — before the pieces list — and must beat the
 *   restore (Task B3, from Task A6's review).
 * - An event that opens NO piece (`show_folder`) must leave the restore alone.
 *   It used to cancel it too, so the user got the "no piece open" state, the
 *   saved last piece / asset were overwritten with null, and a `?piece=` deep
 *   link was ignored and never stripped (Task 13 review, Minor 1).
 */

// ── Controllable inputs ─────────────────────────────────────────────────
type NavEvent = { target: string; pieceId: string; fileId?: string; id?: string };
const navListeners = new Set<(e: NavEvent) => void>();
const nav = vi.hoisted(() => ({ search: "" }));
const pieces = vi.hoisted(() => ({ data: undefined as { id: string; name: string }[] | undefined }));
const routerReplace = vi.fn();
const setLastPieceId = vi.fn();
const setLastAssetId = vi.fn();
let editorState: Record<string, unknown>;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: routerReplace, push: vi.fn() }),
  usePathname: () => "/editor",
  useSearchParams: () => new URLSearchParams(nav.search),
}));

vi.mock("@/hooks/sessions/use-agent-chat", () => ({
  navigateEmitter: {
    on: (fn: (e: NavEvent) => void) => {
      navListeners.add(fn);
      return () => navListeners.delete(fn);
    },
  },
}));

vi.mock("@/lib/editor-state-context", () => ({ useEditorState: () => editorState }));

vi.mock("@/lib/queries/pieces", () => ({
  pieceKeys: { all: ["pieces"] },
  usePieces: () => ({ data: pieces.data, isError: false, isFetching: false, refetch: vi.fn() }),
  usePiece: () => ({ data: undefined, isLoading: false, isError: false }),
  useUpdatePieceName: () => ({ mutate: vi.fn() }),
  useCreatePiece: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("@/lib/queries/files", () => ({
  useFiles: () => ({ data: [] }),
  fileKeys: { forPiece: (id: string) => ["files", id] },
  uploadFileTo: vi.fn(),
}));
vi.mock("@/lib/queries/asset-folders", () => ({ useAssetFolderList: () => ({ data: [] }) }));
vi.mock("@/lib/queries/snapshots", () => ({ usePieceState: () => ({ data: undefined }) }));
vi.mock("@/hooks/editor/use-composition", () => ({
  useComposition: () => ({ composition: null, totalFrames: 0, isLoading: false, isFetching: false, manifest: null }),
}));
vi.mock("@/hooks/editor/use-overlay-editing", () => ({
  useOverlayEditing: () => ({ editingOverlay: null, startEdit: vi.fn(), commit: vi.fn(), cancel: vi.fn() }),
}));
vi.mock("@/hooks/editor/use-export-flow", () => ({ useExportFlow: () => ({}) }));
vi.mock("@/hooks/editor/use-composition-refresh-subscription", () => ({
  useCompositionRefreshSubscription: () => {},
}));
vi.mock("@/lib/preview/telemetry", () => ({ useReactRenderTelemetry: () => {} }));
vi.mock("@/components/onboarding/first-launch-gate", () => ({
  FirstLaunchGate: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Every rendered child is a stub: what is under test is the page's own state.
const stub = (name: string) => {
  const Stub = () => <div data-testid={name} />;
  Stub.displayName = name;
  return Stub;
};
vi.mock("@/components/layout/editor-layout", () => ({
  default: ({ editorPanel }: { editorPanel: ReactNode }) => <div>{editorPanel}</div>,
}));
vi.mock("@/components/chat/chat-panel", () => ({ default: stub("chat-panel") }));
vi.mock("@/components/terminal/terminal-panel", () => ({ default: stub("terminal-panel") }));
vi.mock("@/components/editor/editor-panel", () => ({
  default: ({ pieceId, activeTab, selectedExportId }: { pieceId: string; activeTab: string; selectedExportId: string | null }) => (
    <div data-testid="editor-panel" data-piece-id={pieceId} data-tab={activeTab} data-selected-export={selectedExportId ?? ""} />
  ),
}));
vi.mock("@/components/editor/asset-preview-panel", () => ({ AssetPreviewPanel: stub("asset-preview") }));
vi.mock("@/components/editor/no-piece-empty-state", () => ({ NoPieceEmptyState: stub("no-piece-empty-state") }));
vi.mock("@/components/resources/resources-panel", () => ({ default: stub("resources-panel") }));
vi.mock("@/components/preview/preview-surface", () => ({ default: stub("preview-surface") }));
vi.mock("@/components/layout/app-sidebar", () => ({ AppSidebar: stub("app-sidebar") }));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarInset: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/components/banner/instructions-updated-banner", () => ({ InstructionsUpdatedBanner: stub("banner") }));

const { default: EditorPage } = await import("@/app/(app)/editor/page");
const { resetAgentHandoffForTests } = await import("@/lib/agents/agent-handoff");
const { openExportInTab } = await import("@/hooks/exports/use-open-export");

// ── Harness ─────────────────────────────────────────────────────────────
const P_LAST = { id: "p-last", name: "Previously open" };
const P_DEEP = { id: "p-deep", name: "Deep-linked" };
const P_NEW = { id: "p-new", name: "Just applied" };

let fetchMock: ReturnType<typeof vi.fn>;

function openPieceCalls(): (string | null)[] {
  return fetchMock.mock.calls
    .filter(([url]) => url === "/api/editor/open-piece")
    .map(([, init]) => (JSON.parse((init as RequestInit).body as string) as { pieceId: string | null }).pieceId);
}

function mountColdEditor() {
  const qc = new QueryClient();
  const tree = () => (
    <QueryClientProvider client={qc}>
      <EditorPage />
    </QueryClientProvider>
  );
  const view = render(tree());
  return {
    ...view,
    emit: (event: NavEvent) => act(() => navListeners.forEach((fn) => fn(event))),
    /** The pieces list arrives — the moment the restore effect can run. */
    piecesArrive: (list: { id: string; name: string }[]) => {
      pieces.data = list;
      view.rerender(tree());
    },
  };
}

beforeEach(() => {
  resetAgentHandoffForTests();
  navListeners.clear();
  nav.search = "";
  pieces.data = undefined; // cold load: the list has not arrived yet
  routerReplace.mockReset();
  setLastPieceId.mockReset();
  setLastAssetId.mockReset();
  editorState = {
    chatVisible: true,
    resourcesVisible: true,
    toggleChat: vi.fn(),
    toggleResources: vi.fn(),
    activeProviderId: null,
    isAgentConnecting: false,
    sessionList: {
      activeSessionId: null,
      sessions: [],
      setActiveSessionId: vi.fn(),
      isLoading: true,
      readiness: { state: "unknown" },
      activeAgentId: null,
      createSession: vi.fn(),
      refresh: vi.fn(),
    },
    lastPieceId: P_LAST.id,
    setLastPieceId,
    lastEditorTab: "preview",
    setLastEditorTab: vi.fn(),
    lastAssetId: null,
    setLastAssetId,
    lastSessionId: null,
    setLastSessionId: vi.fn(),
    assetCurrentFolderId: null,
    setAssetCurrentFolderId: vi.fn(),
    assetOriginFolderId: null,
    setAssetOriginFolderId: vi.fn(),
  };
  fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("editor page — a navigate event during a cold load vs the last-piece restore", () => {
  it("a folder reveal before the pieces list arrives still lets the last piece restore", () => {
    const page = mountColdEditor();
    page.emit({ target: "folder", pieceId: "", id: "folder-1" });
    page.piecesArrive([P_LAST, P_NEW]);

    expect(page.getByTestId("editor-panel").getAttribute("data-piece-id")).toBe(P_LAST.id);
    expect(page.queryByTestId("no-piece-empty-state")).toBeNull();
    expect(openPieceCalls()).toContain(P_LAST.id);
    // The saved snapshot is never overwritten with "nothing open".
    expect(setLastPieceId).not.toHaveBeenCalledWith(null);
    expect(setLastPieceId).toHaveBeenLastCalledWith(P_LAST.id);
  });

  it("a folder reveal before the pieces list arrives leaves the saved last asset to restore", async () => {
    editorState.lastAssetId = "a-last";
    fetchMock.mockImplementation(async (url: string) =>
      url === "/api/files/by-id/a-last"
        ? new Response(JSON.stringify({ file: { id: "a-last", pieceId: P_LAST.id, folderId: null } }), { status: 200 })
        : new Response("{}", { status: 200 }),
    );
    const page = mountColdEditor();
    page.emit({ target: "folder", pieceId: "", id: "folder-1" });
    page.piecesArrive([P_LAST]);

    // The restore awaits a fetch and a render; under a loaded full run that can outlast
    // waitFor's 1 s default, so give it room without changing what is asserted.
    await waitFor(() => expect(page.getByTestId("asset-preview")).toBeTruthy(), { timeout: 5000 });
    // The saved id is written from an effect that can land a turn after the
    // preview shows (a loaded CI runner caught it between, 2026-10-02).
    await waitFor(() => expect(setLastAssetId).toHaveBeenLastCalledWith("a-last"), { timeout: 5000 });
    expect(setLastAssetId).not.toHaveBeenCalledWith(null);
  });

  it("a folder reveal before the pieces list arrives still honours a ?piece= deep link, and strips it", () => {
    nav.search = `piece=${P_DEEP.id}`;
    const page = mountColdEditor();
    page.emit({ target: "folder", pieceId: "", id: "folder-1" });
    page.piecesArrive([P_LAST, P_DEEP]);

    expect(page.getByTestId("editor-panel").getAttribute("data-piece-id")).toBe(P_DEEP.id);
    expect(openPieceCalls()).toContain(P_DEEP.id);
    expect(routerReplace).toHaveBeenCalledWith("/editor", { scroll: false });
  });

  it("an event that opens a piece still wins over the restore", () => {
    const page = mountColdEditor();
    page.emit({ target: "piece", pieceId: P_NEW.id });
    page.piecesArrive([P_LAST, P_NEW]);

    expect(page.getByTestId("editor-panel").getAttribute("data-piece-id")).toBe(P_NEW.id);
    expect(openPieceCalls()).not.toContain(P_LAST.id);
    expect(setLastPieceId).toHaveBeenLastCalledWith(P_NEW.id);
  });

  it("an event that opens a piece still wins over a ?piece= deep link", () => {
    nav.search = `piece=${P_DEEP.id}`;
    const page = mountColdEditor();
    page.emit({ target: "preview", pieceId: P_NEW.id });
    page.piecesArrive([P_LAST, P_DEEP, P_NEW]);

    expect(page.getByTestId("editor-panel").getAttribute("data-piece-id")).toBe(P_NEW.id);
    expect(openPieceCalls()).not.toContain(P_DEEP.id);
  });
});

describe("editor page — an export the finish toast opens vs the last-piece restore", () => {
  it("toast Open on a cold load lands on the Exports tab with that export selected", async () => {
    // The toast fires while the editor page is not mounted: the intent is parked.
    openExportInTab({ pieceId: P_NEW.id, exportId: "exp_7" });
    const page = mountColdEditor();
    await act(async () => {}); // the parked intent is delivered on a microtask
    page.piecesArrive([P_LAST, P_NEW]);

    const panel = page.getByTestId("editor-panel");
    expect(panel.getAttribute("data-piece-id")).toBe(P_NEW.id);
    expect(panel.getAttribute("data-tab")).toBe("exports");
    expect(panel.getAttribute("data-selected-export")).toBe("exp_7");
    // The restore neither reopened the previous piece nor reset the tab to the saved one.
    expect(openPieceCalls()).not.toContain(P_LAST.id);
    expect(setLastPieceId).toHaveBeenLastCalledWith(P_NEW.id);
  });

  it("the same intent on a warm page (no restore pending) still opens it", async () => {
    const page = mountColdEditor();
    page.piecesArrive([P_LAST, P_NEW]);
    act(() => openExportInTab({ pieceId: P_NEW.id, exportId: "exp_8" }));

    const panel = page.getByTestId("editor-panel");
    expect(panel.getAttribute("data-piece-id")).toBe(P_NEW.id);
    expect(panel.getAttribute("data-tab")).toBe("exports");
    expect(panel.getAttribute("data-selected-export")).toBe("exp_8");
  });
});
