"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useEditorState } from "@/lib/editor-state-context";
import { navigateEmitter } from "@/hooks/sessions/use-agent-chat";
import type { FileRecord } from "@/lib/db/schema/types";
import EditorLayout from "@/components/layout/editor-layout";
import ChatPanel from "@/components/chat/chat-panel";
import TerminalPanel from "@/components/terminal/terminal-panel";
import EditorPanel from "@/components/editor/editor-panel";
import { AssetPreviewPanel } from "@/components/editor/asset-preview-panel";
import { NoPieceEmptyState } from "@/components/editor/no-piece-empty-state";
import ResourcesPanel from "@/components/resources/resources-panel";
import PreviewSurface from "@/components/preview/preview-surface";
import { useComposition } from "@/hooks/editor/use-composition";
import { useOverlayEditing } from "@/hooks/editor/use-overlay-editing";
import { useExportFlow } from "@/hooks/editor/use-export-flow";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Film, Plus, RefreshCw, TriangleAlert } from "lucide-react";
import { pieceKeys, usePiece, usePieces, useUpdatePieceName, useCreatePiece } from "@/lib/queries/pieces";
import { resolvePiecesScreen } from "@/lib/pieces/pieces-screen";
import { useAssetFolderList } from "@/lib/queries/asset-folders";
import { getAncestorIds } from "@/lib/folders/tree";
import { useFiles } from "@/lib/queries/files";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { pickVideoUrl } from "@/lib/proxy/url";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { SidebarInset } from "@/components/ui/sidebar";
import { InstructionsUpdatedBanner } from "@/components/banner/instructions-updated-banner";
import { usePieceState } from "@/lib/queries/snapshots";
import { useReactRenderTelemetry } from "@/lib/preview/telemetry";
import { OnboardingPanel } from "@/components/onboarding/onboarding-panel";
import { InlineApiConfigPanel } from "@/components/mcp-config/inline-api-config-panel";
import { PersonaModal } from "@/components/onboarding/persona-modal";
import { readinessAllowsChat } from "@/lib/agents/agent-readiness";

export default function EditorPage() {
  useReactRenderTelemetry("EditorPage");
  const {
    chatVisible,
    resourcesVisible,
    toggleChat,
    toggleResources,
    activeProviderId,
    sessionList,
    lastPieceId,
    setLastPieceId,
    lastEditorTab,
    setLastEditorTab,
    lastAssetId,
    setLastAssetId,
    lastSessionId,
    setLastSessionId,
    assetCurrentFolderId,
    setAssetCurrentFolderId,
    assetOriginFolderId,
    setAssetOriginFolderId,
    rightRegionMode,
    setRightRegionMode,
    apiConfigMcpId,
    setOnboardingDemoOffer,
  } = useEditorState();

  const queryClient = useQueryClient();

  // Reuse the same key as PersonaModal so we get one shared fetch.
  const { data: onboardingState } = useQuery({
    queryKey: ["onboarding-state"],
    queryFn: async () => (await fetch("/api/onboarding/state")).json(),
  });

  // Auto-open the onboarding panel on first run: fires once when the data
  // lands, persona is already collected (modal is dismissed), and the user
  // hasn't manually picked another mode (rightRegionMode is still "editor").
  const onboardingOpenedRef = useRef(false);
  useEffect(() => {
    if (onboardingOpenedRef.current) return;
    if (!onboardingState) return;
    if (onboardingState.needsPersona) return; // persona modal is still up
    if (!onboardingState.needsOnboarding) return; // already connected before
    if (rightRegionMode !== "editor") return; // user has chosen another mode
    onboardingOpenedRef.current = true;
    setRightRegionMode("onboarding");
  }, [onboardingState, rightRegionMode, setRightRegionMode]);

  // Leave onboarding the moment an agent is connected — whether the user
  // picked it from the onboarding panel OR the sidebar agent selector. This
  // reveals the chat (or terminal) surface instead of stranding them on the
  // connect screen, and arms the one-tap "Show me how it works" demo offer.
  // Both surfaces honour the offer: the chat panel sends the prompt to the ACP
  // agent; the terminal panel pastes it into the live PTY.
  useEffect(() => {
    if (rightRegionMode !== "onboarding") return;
    if (!activeProviderId) return; // nothing connected yet
    setRightRegionMode("editor");
    setOnboardingDemoOffer(true);
  }, [activeProviderId, rightRegionMode, setRightRegionMode, setOnboardingDemoOffer]);

  const piecesQuery = usePieces();
  const createPiece = useCreatePiece();

  // Active piece managed as state (not URL param)
  const [activePieceId, setActivePieceId] = useState<string | null>(null);

  // Folder reveal request in the resources panel (driven by libi.show_folder).
  // A monotonic `nonce` lets a repeated reveal of the SAME folder id re-fire —
  // requestAnimationFrame is unreliable for this (it never runs when the
  // window is backgrounded, which is exactly when the agent calls show_folder).
  const [revealFolder, setRevealFolder] = useState<{ id: string; nonce: number } | null>(null);

  // Track whether we've already attempted to restore the previously-opened
  // piece/asset/tab from localStorage. Once true, persist effects start
  // writing back; before true, we don't clobber the saved snapshot with the
  // initial null state of the editor page.
  const [restoreAttempted, setRestoreAttempted] = useState(false);
  const restoreAttemptedRef = useRef(false);
  restoreAttemptedRef.current = restoreAttempted;

  // Conditional queries — only fetch when we have an active piece
  const pieceQuery = usePiece(activePieceId!, { enabled: !!activePieceId });
  const filesQuery = useFiles(activePieceId ?? "");

  // All folders for the active piece — used to derive the breadcrumb origin on
  // close and to step up one level on mouse-back. Guarded to a real pieceId so
  // we never fetch GLOBAL folders (scope=null) when no piece is open.
  const { data: assetFolders = [] } = useAssetFolderList(activePieceId, {
    enabled: !!activePieceId,
  });

  // Resolve a fileId to the best-available URL (proxy when ready, original otherwise).
  const fileSrcResolver = useCallback((fileId: string) => {
    const file = filesQuery.data?.find((f) => f.id === fileId);
    if (file && file.type === "video") return pickVideoUrl(file);
    return `/api/files/by-id/${fileId}/content`;
  }, [filesQuery.data]);

  // Audio clips come from the composition (derived in useComposition).
  // Queued auto-show seek — applied once the target piece's composition finishes loading.
  const [pendingSeek, setPendingSeek] = useState<{ pieceId: string; sceneId: string } | null>(null);

  // Restore the previously active chat session (or fall back to the most
  // recent one if the saved session no longer exists).
  // Guarded so that LRU eviction (which can null the active session mid-use)
  // doesn't flicker the UI by silently re-selecting something else.
  const sessionRestoreAttemptedRef = useRef(false);
  const [sessionRestoreAttempted, setSessionRestoreAttempted] = useState(false);
  useEffect(() => {
    if (sessionRestoreAttemptedRef.current) return;
    if (sessionList.activeSessionId) {
      sessionRestoreAttemptedRef.current = true;
      setSessionRestoreAttempted(true);
      return;
    }
    if (sessionList.sessions.length === 0) return;
    sessionRestoreAttemptedRef.current = true;
    setSessionRestoreAttempted(true);
    // Try the saved session first; fall back to the most recent.
    const saved =
      lastSessionId &&
      sessionList.sessions.find((s) => s.sessionId === lastSessionId);
    sessionList.setActiveSessionId(
      saved ? saved.sessionId : sessionList.sessions[0].sessionId,
    );
  }, [
    sessionList.sessions,
    sessionList.activeSessionId,
    sessionList.setActiveSessionId,
    lastSessionId,
  ]);

  // Persist active session id once restoration is done.
  useEffect(() => {
    if (!sessionRestoreAttempted) return;
    setLastSessionId(sessionList.activeSessionId);
  }, [sessionRestoreAttempted, sessionList.activeSessionId, setLastSessionId]);

  // Auto-create first session if list is empty and agent is selected.
  // Reset the guard when the agent changes so a fresh agent with zero
  // sessions still gets a standby session created.
  const autoCreateForAgentRef = useRef<string | null>(null);
  useEffect(() => {
    if (sessionList.isLoading) return;
    if (!activeProviderId) return;
    // Terminal surface has no ACP session to auto-create — the user opens
    // terminals explicitly (and POST /api/sessions would 400 anyway).
    if (activeProviderId === "terminal") return;
    // Wait until the SERVER confirms the agent switch. `activeProviderId`
    // is optimistic (set on click); /api/agent/start returns before the
    // switch completes, so posting now races SessionManager.activeAgentId
    // still being null → 400 "No active agent".
    if (sessionList.activeAgentId !== activeProviderId) return;
    if (sessionList.sessions.length > 0) return;
    // Don't fire a creation we already know the agent will refuse. An
    // unauthenticated agent answers `session/new` with -32000, so this POST
    // 500s on EVERY page load — a console error per load, plus a doomed ACP
    // round-trip, for an outcome the readiness state has already told us.
    // `readinessAllowsChat` treats "unknown" as permitted, so the normal
    // first-load path (nothing observed yet) is unchanged.
    if (!readinessAllowsChat(sessionList.readiness)) return;
    if (autoCreateForAgentRef.current === activeProviderId) return;
    autoCreateForAgentRef.current = activeProviderId;
    sessionList.createSession();
  }, [
    sessionList.isLoading,
    sessionList.sessions.length,
    sessionList.activeAgentId,
    sessionList.readiness,
    activeProviderId,
    sessionList.createSession,
  ]);

  // Editor panel tab state
  const [editorTab, setEditorTab] = useState<"preview" | "storyboard" | "assets" | "objects">("preview");
  const [selectedAsset, setSelectedAsset] = useState<FileRecord | null>(null);

  // ── Restore the previously-opened piece / tab / asset on mount ─────
  //
  // Strategy:
  //  - If `lastPieceId` is saved AND the piece still exists, set it as
  //    active and restore the tab + (best-effort) the asset.
  //  - Otherwise, do nothing — the user will see the "no piece open"
  //    empty state and pick something from the resources tree.
  //
  // The persist effects below are gated on `restoreAttempted` so we don't
  // clobber the saved snapshot before we've had a chance to read it.
  // Tracks whether the async asset-restore fetch is still in-flight. While
  // true the persist effect for `lastAssetId` is suppressed so the initial
  // `selectedAsset === null` (between restore-effect-fire and fetch-resolve)
  // doesn't clobber the saved id.
  const [assetRestoreInFlight, setAssetRestoreInFlight] = useState(false);

  useEffect(() => {
    if (restoreAttemptedRef.current) return;
    const pieces = piecesQuery.data;
    if (!pieces) return; // still loading
    restoreAttemptedRef.current = true;
    setRestoreAttempted(true);

    if (lastPieceId && pieces.some((p) => p.id === lastPieceId)) {
      setActivePieceId(lastPieceId);
      setEditorTab(lastEditorTab);
      if (lastAssetId) {
        // Best-effort asset restore. If the asset was deleted or the fetch
        // fails, we silently leave the user on the piece view.
        setAssetRestoreInFlight(true);
        void (async () => {
          try {
            const res = await fetch(`/api/files/by-id/${lastAssetId}`);
            if (!res.ok) return;
            const { file } = (await res.json()) as { file: FileRecord };
            if (file) setSelectedAsset(file);
          } catch {
            // ignore
          } finally {
            setAssetRestoreInFlight(false);
          }
        })();
      }
    }
    // else: leave activePieceId null → empty state renders below.
  }, [piecesQuery.data, lastPieceId, lastEditorTab, lastAssetId]);

  // Persist piece / tab / asset on changes — only after restore has been
  // attempted, so the initial null state of the editor page doesn't
  // overwrite the saved snapshot before we've read it.
  useEffect(() => {
    if (!restoreAttempted) return;
    setLastPieceId(activePieceId);
  }, [restoreAttempted, activePieceId, setLastPieceId]);
  useEffect(() => {
    if (!restoreAttempted) return;
    setLastEditorTab(editorTab);
  }, [restoreAttempted, editorTab, setLastEditorTab]);
  useEffect(() => {
    if (!restoreAttempted) return;
    if (assetRestoreInFlight) return;
    setLastAssetId(selectedAsset?.id ?? null);
  }, [restoreAttempted, assetRestoreInFlight, selectedAsset, setLastAssetId]);

  const handleSelectAsset = useCallback((file: FileRecord) => {
    // Explorer open: remember the folder we're leaving from so close returns here.
    setAssetOriginFolderId(assetCurrentFolderId);
    setSelectedAsset(file);
    setEditorTab("assets");
  }, [assetCurrentFolderId, setAssetOriginFolderId]);

  const handleSelectAssetFromTree = useCallback((targetPieceId: string | null, file: FileRecord) => {
    // Switch to the target piece and show the asset (global files have null pieceId — don't change active piece)
    if (targetPieceId) {
      setActivePieceId(targetPieceId);
    }
    // Opening from the tree/chat: align the explorer to the file's own folder so
    // closing the asset lands the user in that folder, not at the previous spot.
    setAssetOriginFolderId(file.folderId ?? null);
    setAssetCurrentFolderId(file.folderId ?? null);
    setSelectedAsset(file);
    setEditorTab("assets");
  }, [setAssetOriginFolderId, setAssetCurrentFolderId]);

  // Same shape as `handleSelectAssetFromTree` but tailored for chat
  // attachment chips — reuses the (pieceId, file) split so global files
  // keep the current piece active rather than blanking it.
  const handleOpenAssetFromChat = useCallback((file: FileRecord) => {
    handleSelectAssetFromTree(file.pieceId, file);
  }, [handleSelectAssetFromTree]);

  // Asset mode is active when a specific asset is selected. Closing the
  // asset returns to piece mode (timeline view).
  const viewMode: "piece" | "asset" = selectedAsset ? "asset" : "piece";

  // `selectedAsset` is a click-time snapshot; server-side mutations to the
  // open file (generation cost resolution, notes appends, renames) land in
  // the files query via refresh_query SSE but not in the snapshot. Prefer
  // the live record from the query cache so the asset panel re-renders with
  // fresh data; fall back to the snapshot (global files aren't in this
  // piece-scoped query).
  const liveSelectedAsset = useMemo(() => {
    if (!selectedAsset) return null;
    return filesQuery.data?.find((f) => f.id === selectedAsset.id) ?? selectedAsset;
  }, [selectedAsset, filesQuery.data]);

  const handleCloseAsset = useCallback(() => {
    // Return to the folder the asset was opened from (not the Preview tab).
    setSelectedAsset(null);
    setAssetCurrentFolderId(assetOriginFolderId);
    setEditorTab("assets");
  }, [assetOriginFolderId, setAssetCurrentFolderId]);

  // Mouse "back" button (button 3): close an open asset, or step up one folder
  // level inside the Assets explorer. `getAncestorIds` returns nearest-parent
  // first, so [0] is the immediate parent.
  useEffect(() => {
    const onMouseUp = (e: MouseEvent) => {
      if (e.button !== 3) return; // 3 = browser-back mouse button
      if (selectedAsset) {
        e.preventDefault();
        handleCloseAsset();
      } else if (editorTab === "assets" && assetCurrentFolderId) {
        e.preventDefault();
        const parent = getAncestorIds(assetCurrentFolderId, assetFolders)[0] ?? null;
        setAssetCurrentFolderId(parent);
      }
    };
    window.addEventListener("mouseup", onMouseUp);
    return () => window.removeEventListener("mouseup", onMouseUp);
  }, [selectedAsset, editorTab, assetCurrentFolderId, assetFolders, handleCloseAsset, setAssetCurrentFolderId]);

  const handleSelectPieceFromTree = useCallback((targetPieceId: string) => {
    setActivePieceId(targetPieceId);
    setEditorTab("preview");
    // Clicking a piece in the resources tree always lands the user on the
    // piece preview, even if they were viewing an asset. Without this clear,
    // `viewMode` would stay in "asset" mode (which renders AssetPreviewPanel)
    // because it's derived from `selectedAsset`.
    setSelectedAsset(null);
  }, []);

  // Creating a piece from the empty-state buttons should open it immediately,
  // not just drop it into the resources panel. The mutation returns the new
  // piece; land the user on its preview (same as selecting from the tree).
  const handleCreatePiece = useCallback(() => {
    createPiece.mutate(undefined, {
      onSuccess: (piece) => {
        setActivePieceId(piece.id);
        setEditorTab("preview");
        setSelectedAsset(null);
      },
    });
  }, [createPiece]);

  const handleDeletePiece = useCallback((deletedPieceId: string) => {
    if (deletedPieceId === activePieceId) {
      // Clear selection — the empty state takes over until the user picks
      // (or asks the agent to create) another piece. We deliberately do NOT
      // auto-jump to a sibling piece; jumping silently after a delete makes
      // it hard to know what just happened.
      setActivePieceId(null);
      setSelectedAsset(null);
    }
  }, [activePieceId]);

  const renamePiece = useUpdatePieceName();
  const handleRenamePiece = useCallback((targetPieceId: string, name: string) => {
    renamePiece.mutate({ pieceId: targetPieceId, name });
  }, [renamePiece]);

  const handleUploadFiles = useCallback(async (targetPieceId: string, files: File[]) => {
    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);
      await fetch(`/api/pieces/${targetPieceId}/upload`, {
        method: "POST",
        body: formData,
      });
    }
    // Switch to the target piece to see uploads
    if (targetPieceId !== activePieceId) {
      setActivePieceId(targetPieceId);
    }
  }, [activePieceId]);

  // Notify server which piece is currently open
  useEffect(() => {
    if (!activePieceId) return;

    fetch("/api/editor/open-piece", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pieceId: activePieceId }),
    })
      // That POST also stamps `lastOpenedAt`, which the "No piece open"
      // recents list orders by. This query is mounted for the whole editor
      // session and has a 30s staleTime, so without an explicit invalidation
      // a user who opened a piece and closed it again inside that window
      // would come back to a list that had not noticed.
      .then(() => queryClient.invalidateQueries({ queryKey: pieceKeys.all }))
      .catch(() => {});

    return () => {
      fetch("/api/editor/open-piece", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pieceId: null }),
      }).catch(() => {});
    };
  }, [activePieceId]);

  // Handle refresh_query SSE events — mutation tools on the server fire
  // `notify.refreshQuery({ queryKey, pieceId, sceneId? })` after mutating.
  //
  // We invalidate the matching React Query cache and, for composition
  // changes, jump the preview to the first changed scene + switch to the
  // Preview tab (auto-show — always on).
  //
  // Name-based dispatch on `queryKey` (not tool name) is deliberate: ACP
  // mangles tool names (`mcp__libi__create_scene`) in transport, so keys are
  // the stable contract.
  const handleRefreshQuery = useCallback(
    (event: { queryKey: string; pieceId?: string; sceneId?: string; fileId?: string }) => {
      // Data-only cache invalidations (pieces, files, piece, analysis,
      // script) are owned by the layout-level subscriber
      // `useGlobalRefreshQuerySubscription`. The editor handler retains
      // ONLY the composition case because it combines invalidation with
      // navigation side effects (auto-show seek, tab switch).
      if (event.queryKey !== "composition") return;
      if (!event.pieceId) return;

      queryClient.invalidateQueries({
        queryKey: pieceKeys.composition(event.pieceId),
      });
      queryClient.invalidateQueries({
        queryKey: ["composition-snapshot", event.pieceId],
      });

      // Auto-show: bring the user to the edited scene. This may involve
      // switching pieces + switching tab. The actual playhead seek happens
      // in the effect below, once the target composition is loaded.
      setActivePieceId(event.pieceId);
      setEditorTab("preview");
      if (event.sceneId) {
        setPendingSeek({ pieceId: event.pieceId, sceneId: event.sceneId });
      }
    },
    [queryClient],
  );

  // Handle navigation events forwarded from the chat SSE
  const handleNavigate = useCallback((event: { target: string; pieceId: string; fileId?: string; id?: string }) => {
    if (event.target === "folder" && event.id) {
      // Bump the nonce so a repeated reveal of the same folder still re-fires.
      const folderId = event.id;
      setRevealFolder((prev) => ({ id: folderId, nonce: (prev?.nonce ?? 0) + 1 }));
      // Ensure the resources panel is visible.
      if (!resourcesVisible) toggleResources();
      return;
    }
    if (event.target === "piece" && event.pieceId) {
      setActivePieceId(event.pieceId);
    } else if (event.target === "asset" && event.pieceId && event.fileId) {
      setActivePieceId(event.pieceId);
      const targetFileId = event.fileId;
      void (async () => {
        try {
          const res = await fetch(`/api/files/by-id/${targetFileId}`);
          if (!res.ok) {
            console.warn(`show_asset: file ${targetFileId} fetch failed (${res.status})`);
            return;
          }
          const { file } = (await res.json()) as { file: FileRecord };
          if (file) {
            // Align the explorer to the file's folder so closing returns there.
            setAssetOriginFolderId(file.folderId ?? null);
            setAssetCurrentFolderId(file.folderId ?? null);
            setSelectedAsset(file);
          }
        } catch (err) {
          console.warn("show_asset: navigation failed", err);
        }
      })();
    } else if (event.target === "preview" && event.pieceId) {
      setActivePieceId(event.pieceId);
      setEditorTab("preview");
    } else if (event.target === "storyboard" && event.pieceId) {
      setActivePieceId(event.pieceId);
      setEditorTab("storyboard");
    }
  }, [resourcesVisible, toggleResources, setAssetOriginFolderId, setAssetCurrentFolderId]);

  // Subscribe to the global navigate emitter so show_piece / show_asset /
  // show_preview ALWAYS reach the editor — even the first one of a turn,
  // which used to race the per-session useAgentChat onNavigate handler and
  // get silently dropped (user then had to ask "show me the piece"). This
  // mirrors useGlobalRefreshQuerySubscription; the per-session onNavigate
  // path is retained but is now redundant for delivery.
  useEffect(() => {
    return navigateEmitter.on(handleNavigate);
  }, [handleNavigate]);

  // If the active piece errors (deleted externally), clear it AND any
  // asset still selected from that piece — otherwise viewMode would stay
  // in "asset" with a dangling FileRecord.
  useEffect(() => {
    if (!pieceQuery.isError) return;
    setActivePieceId(null);
    setSelectedAsset(null);
  }, [pieceQuery.isError]);

  const {
    composition,
    totalFrames,
    rawScenes: scenes,
    isLoading: isCompositionLoading,
    isFetching: isCompositionFetching,
    manifest,
  } = useComposition(activePieceId);

  const {
    editingOverlay,
    startEdit: handleStartEditOverlay,
    commit: handleCommitOverlay,
    cancel: handleCancelOverlay,
  } = useOverlayEditing(activePieceId, composition);

  const { data: pieceState } = usePieceState(activePieceId ?? "");
  const hasSnapshot = !!(pieceState?.snapshotCommittedAt);
  const hasDraft = pieceState?.hasDraft ?? true;

  const exportFlow = useExportFlow();

  const isLoadingQueries = !!activePieceId && (pieceQuery.isLoading || isCompositionLoading);

  // Which whole-page screen we owe the user before a piece is open. The
  // "no pieces" and "couldn't load pieces" cases used to share one branch
  // (`(data ?? []).length === 0`), which showed a user with a full library
  // "Welcome to libi — create your first piece". See lib/pieces/pieces-screen.ts.
  const piecesScreen = resolvePiecesScreen({
    hasActivePiece: !!activePieceId,
    isError: piecesQuery.isError,
    data: piecesQuery.data,
  });

  // Couldn't load the library at all. Say that, and offer the retry — never
  // the create-your-first-piece screen, whose button POSTs to the very
  // endpoint that just failed and so appears to do nothing.
  if (piecesScreen === "unavailable") {
    return (
      <>
        {/* Asking who they are does not depend on the library loading. */}
        <PersonaModal />
        <AppSidebar />
        <SidebarInset className="flex h-full flex-col overflow-hidden">
          <InstructionsUpdatedBanner />
          <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6">
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="grid size-20 place-items-center rounded-2xl bg-destructive/10">
                <TriangleAlert className="size-8 text-destructive" strokeWidth={1.5} />
              </div>
              <h2 className="font-brand text-3xl font-semibold text-foreground">
                Couldn&rsquo;t load your pieces
              </h2>
              <p className="max-w-md text-sm text-muted-foreground">
                Your work is still on disk — the editor just can&rsquo;t reach it
                right now. If this keeps happening after a retry, restart libi
                and check <span className="font-mono text-xs">~/.libi/logs/server.log</span>.
              </p>
            </div>
            <Button
              className="cursor-pointer"
              onClick={() => void piecesQuery.refetch()}
              disabled={piecesQuery.isFetching}
              size="lg"
              variant="outline"
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${piecesQuery.isFetching ? "animate-spin" : ""}`}
                strokeWidth={2.2}
              />
              {piecesQuery.isFetching ? "Retrying…" : "Try again"}
            </Button>
          </div>
        </SidebarInset>
      </>
    );
  }

  // NOTE: there is deliberately NO early return for `piecesScreen === "welcome"`.
  // A brand-new user with zero pieces falls through to the normal EditorLayout
  // below, whose empty-state carries the first-run copy (`firstRun` on
  // NoPieceEmptyState). It used to return here, and that one early return
  // silently swallowed the ENTIRE onboarding: the persona modal, the
  // connect-an-agent takeover and the demo offer chip all live in the main
  // return, so the only user who never saw any of them was the brand-new one
  // they were written for. Onboarding appeared *after* you created a piece,
  // which is backwards. Keep first-run rendering inside the layout.

  // While pieces are loading and restore hasn't run yet, show a spinner.
  // We deliberately keep the EditorLayout (chat + resources) hidden in this
  // very brief window so the user doesn't see panels with empty content.
  if (!activePieceId && !restoreAttempted) {
    return (
      <>
        <PersonaModal />
        <AppSidebar />
        <SidebarInset className="flex h-full flex-col overflow-hidden">
          <InstructionsUpdatedBanner />
          <div className="flex flex-1 items-center justify-center">
            <Skeleton className="h-8 w-48" />
          </div>
        </SidebarInset>
      </>
    );
  }

  const rightTakeover =
    rightRegionMode === "onboarding" ? (
      <OnboardingPanel />
    ) : rightRegionMode === "api-config" ? (
      <InlineApiConfigPanel mcpId={apiConfigMcpId} />
    ) : undefined;

  return (
    <>
      <PersonaModal />
      <AppSidebar />
      <SidebarInset className="flex h-full flex-col overflow-hidden">
        <InstructionsUpdatedBanner />
        <EditorLayout
        rightTakeover={rightTakeover}
        rightTakeoverFull={rightRegionMode === "onboarding"}
        chatPanel={
          activeProviderId === "terminal" ? (
            <TerminalPanel />
          ) : (
          <ChatPanel
            sessionId={sessionList.activeSessionId}
            // Empty string = "no piece scope". The agent can still chat (and
            // create a new piece via libi.create_piece); per-piece operations
            // like file upload are gated by the upstream UI when needed.
            pieceId={activePieceId ?? ""}
            onNavigate={handleNavigate}
            onRefreshQuery={handleRefreshQuery}
            onSessionsChanged={sessionList.refresh}
            onOpenAsset={handleOpenAssetFromChat}
            onNewChat={() => {
              void sessionList.createSession();
            }}
          />
          )
        }
      editorPanel={
        !activePieceId ? (
          // Pieces exist but none is open. Surface the empty state inline so
          // the resources panel + chat stay accessible — the user can pick a
          // piece from the tree, ask the agent to create one, or hit the
          // "New piece" button. Carries the same chat/resources toggles as
          // the piece/asset panels so a collapsed panel can always be reopened.
          <NoPieceEmptyState
            onCreatePiece={handleCreatePiece}
            creating={createPiece.isPending}
            chatOpen={chatVisible}
            resourcesOpen={resourcesVisible}
            onToggleChat={toggleChat}
            onToggleResources={toggleResources}
            pieces={piecesQuery.data ?? []}
            onOpenPiece={setActivePieceId}
            firstRun={piecesScreen === "welcome"}
          />
        ) : isLoadingQueries ? (
          <div className="flex h-full flex-col">
            <div className="flex flex-1 min-h-0 items-center justify-center bg-background p-4">
              <Skeleton className="aspect-video w-full max-w-2xl rounded-lg" />
            </div>
            <div className="shrink-0 border-t border-border p-3">
              <Skeleton className="h-8 w-full rounded-md" />
            </div>
          </div>
        ) : viewMode === "asset" && liveSelectedAsset ? (
          <AssetPreviewPanel
            asset={liveSelectedAsset}
            onClose={handleCloseAsset}
            chatOpen={chatVisible}
            resourcesOpen={resourcesVisible}
            onToggleChat={toggleChat}
            onToggleResources={toggleResources}
          />
        ) : (
        <EditorPanel
          activeTab={editorTab}
          onTabChange={setEditorTab}
          onSelectAsset={handleSelectAsset}
          piece={pieceQuery.data ?? null}
          chatOpen={chatVisible}
          resourcesOpen={resourcesVisible}
          onToggleChat={toggleChat}
          onToggleResources={toggleResources}
          pieceId={activePieceId}
          previewArea={
            <PreviewSurface
              composition={composition}
              totalFrames={totalFrames}
              scenes={scenes}
              pieceId={activePieceId ?? ""}
              pieceName={pieceQuery.data?.name ?? null}
              files={filesQuery.data ?? []}
              exportFlow={exportFlow}
              hasSnapshot={hasSnapshot}
              hasDraft={hasDraft}
              editingOverlay={editingOverlay}
              onEditOverlay={handleStartEditOverlay}
              onOverlayCommit={handleCommitOverlay}
              onOverlayCancel={handleCancelOverlay}
              pendingSeek={pendingSeek}
              isCompositionFetching={isCompositionFetching}
              onPendingSeekConsumed={() => setPendingSeek(null)}
            />
          }
        />
        )
      }
        resourcesPanel={
          <ResourcesPanel
            activePieceId={activePieceId}
            onSelectPiece={handleSelectPieceFromTree}
            onSelectAsset={handleSelectAssetFromTree}
            onDeletePiece={handleDeletePiece}
            onRenamePiece={handleRenamePiece}
            onUploadFiles={handleUploadFiles}
            revealFolder={revealFolder}
            onClose={toggleResources}
          />
        }
        />
      </SidebarInset>
    </>
  );
}
