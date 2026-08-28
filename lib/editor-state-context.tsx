"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MutableRefObject,
  type ReactNode,
} from "react";
import type { PreviewQuality } from "@/lib/preview/tuning";
import {
  groupsForKind,
  defaultGroupForKind,
  type InspectorGroup,
  type InspectorOverlayKind,
} from "@/lib/overlays/inspector-fields";
import { DEFAULT_TERMINAL_CLI_ID } from "@/lib/terminal/presets";

import { useRouter } from "next/navigation";
import { useSessionList, type UseSessionList } from "@/hooks/sessions/use-session-list";
import { subscribeBroadcast } from "@/hooks/sessions/use-agent-chat";
import type { AgentReadiness } from "@/lib/agents/agent-readiness";

// ── Agent provider types ───────────────────────────────────────────────

export interface ProviderInfo {
  id: string;
  name: string;
  available: boolean;
  capabilities: { canListSessions: boolean };
  /**
   * Present only on unavailable providers. The list handed to consumers is
   * deliberately UNFILTERED so the selector can show an unavailable agent
   * disabled-with-a-reason; consumers that need only selectable agents filter
   * on `available` themselves (see onboarding-panel.tsx).
   */
  unavailableReason?: import("@/lib/agents/types").AgentUnavailableReason;
  [key: string]: unknown;
}

// The active agent is sourced from the server: `SessionManager._activeAgentId`
// is exposed via /api/sessions and consumed by useSessionList. The persistent
// cross-restart preference lives in the settings DB (`preferredAgent`) and is
// applied at server startup by instrumentation.ts. There is intentionally no
// client-side cache for the active agent — a second source of truth would
// just drift out of sync with the warmed process and break the selector UI.

// ── Persisted state shape ──────────────────────────────────────────────

interface PersistedEditorState {
  chatVisible: boolean;
  resourcesVisible: boolean;
  panelSizes: {
    resources: number;
    editor: number;
    chat: number;
  };
  /** Point-text canvas snapping (frame guides + sibling anchors + angle detents).
   *  Global, default ON. Holding Alt during a gesture bypasses it transiently. */
  snapEnabled: boolean;
  /** Preview decode quality (per-device performance pref). See PreviewQuality. */
  previewQuality: PreviewQuality;
  /**
   * Per-overlay inspector tab (intent group), keyed pieceId → overlayId →
   * InspectorGroup. Mirrors `overlayLockedPieces`. A missing entry (or one no
   * longer available for the overlay's kind, or a stale complexity-tier value)
   * reads as the kind's default group.
   */
  overlayInspectorModePieces: Record<string, Record<string, InspectorGroup>>;
  /** Asset preview top-section size (%) when in asset mode default layout. Shared across all assets. */
  assetPanelSplit: number;
  /**
   * Per-asset view-mode override. Keyed by `file.id`. Missing entries default
   * to `"split"` (the standard top-video / bottom-tabs layout). The user
   * toggles per asset; the choice persists for that asset across reloads.
   */
  assetViewModes: Record<string, "split" | "full">;
  /**
   * "Last opened" snapshot — restored on next visit so the user lands on the
   * same piece / asset / chat session they left. Each field falls back to
   * null when the referenced entity no longer exists at restore time.
   */
  lastPieceId: string | null;
  lastEditorTab: "preview" | "storyboard" | "assets" | "objects";
  lastAssetId: string | null;
  /** Last active tab inside the asset preview panel. */
  lastAssetTab: "preview" | "summary" | "transcript" | "frames" | "script" | "generation" | "notes";
  /** Width % of the Script tab's left shot-rail in the two-pane split. */
  scriptShotRailPct: number;
  /** Height % of the top (preview+details) section in the Timeline-tab vertical split. Shared across pieces. */
  previewTimelineSplit: number;
  /** Effects picker panel height in px. Global, shared across pieces. Clamped to [200, 560]. */
  effectsPanelHeight: number;
  /** Timeline horizontal zoom in content px-per-second. null = "fit / not yet set". Global, shared across pieces. */
  previewTimelineZoom: number | null;
  /** Effects picker panel open/closed. Global, persisted so it survives reload. */
  effectsPanelOpen: boolean;
  /** Whether the user dismissed the "Connect Codex" first-use nudge. Global, persisted. */
  codexNudgeDismissed: boolean;
  /** Last selected effect phase sub-tab (in/out/loop). Global. */
  effectsLastPhase: "in" | "out" | "loop";
  /** Width % of the preview side in the Timeline-tab preview|layers split. Shared across pieces. */
  previewLayersSplit: number;
  /** Per-piece layers-panel dock flag. Keyed by pieceId; missing = hidden. */
  previewLayersDockedPieces: Record<string, boolean>;
  /** Per-piece editor-only overlay lock map: pieceId → overlayId → true. */
  overlayLockedPieces: Record<string, Record<string, boolean>>;
  /** Per-piece editor-only "Size control is split into W/H rows" map: pieceId → overlayId → true. */
  overlaySizeSplitPieces: Record<string, Record<string, boolean>>;
  lastSessionId: string | null;
  /** Selected "Launch CLI" preset for new terminal sessions (lib/terminal/presets.ts id). */
  terminalCliId: string;
  /** Controls what renders in the right region (right of chat). Persisted so the user's last view is restored. */
  rightRegionMode: RightRegionMode;
}

const STORAGE_KEY = "libi:editor-state";

const DEFAULTS: PersistedEditorState = {
  chatVisible: true,
  // New-user default: a focused layout — only the always-on timeline panel + chat.
  // Resources is OFF by default. Global flag ⇒ once the user opens Resources it
  // carries forward to every future piece and boot via the persisted blob.
  resourcesVisible: false,
  panelSizes: { chat: 35, editor: 45, resources: 20 },
  snapEnabled: true,
  previewQuality: "auto",
  overlayInspectorModePieces: {},
  assetPanelSplit: 50,
  assetViewModes: {},
  lastPieceId: null,
  lastEditorTab: "preview",
  lastAssetId: null,
  lastAssetTab: "summary",
  scriptShotRailPct: 35,
  previewTimelineSplit: 72,
  effectsPanelHeight: 300,
  previewTimelineZoom: null,
  effectsPanelOpen: false,
  codexNudgeDismissed: false,
  effectsLastPhase: "in",
  previewLayersSplit: 64,
  previewLayersDockedPieces: {},
  overlayLockedPieces: {},
  overlaySizeSplitPieces: {},
  lastSessionId: null,
  terminalCliId: DEFAULT_TERMINAL_CLI_ID,
  rightRegionMode: "editor",
};

const OLD_LAYOUT_KEY = "libi:panel-layout";

/** Drop entries that aren't `"split" | "full"` so a malformed blob can't poison the map. */
function sanitizeAssetViewModes(
  raw: Record<string, unknown>,
): Record<string, "split" | "full"> {
  const out: Record<string, "split" | "full"> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === "split" || v === "full") out[k] = v;
  }
  return out;
}

/** Accept a persisted split % only when it can't collapse a panel (5–95 exclusive); anything else falls back to the default. */
function clampSplit(raw: unknown, fallback: number): number {
  return typeof raw === "number" && raw > 5 && raw < 95 ? raw : fallback;
}

/** Clamp the effects panel height (px) into [200, 560]; junk → default. */
function clampEffectsHeight(v: unknown): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : DEFAULTS.effectsPanelHeight;
  return Math.min(560, Math.max(200, n));
}

/** Coerce any persisted/incoming value into a valid InspectorGroup; junk → "transform". */
export function sanitizeInspectorGroup(v: unknown): InspectorGroup {
  return v === "transform" || v === "style" || v === "text" || v === "3d" || v === "anchors"
    ? v
    : "transform";
}

/** Keep only nested valid-InspectorGroup entries — pieceId → overlayId → group.
 *  Stale complexity-tier values (simple/advanced/expert) are dropped (they read
 *  back as the kind's default group via getOverlayInspectorMode). */
function sanitizeOverlayModeMap(
  raw: Record<string, unknown>,
): Record<string, Record<string, InspectorGroup>> {
  const out: Record<string, Record<string, InspectorGroup>> = {};
  for (const [pieceId, inner] of Object.entries(raw)) {
    if (!inner || typeof inner !== "object") continue;
    const kept: Record<string, InspectorGroup> = {};
    for (const [ovId, v] of Object.entries(inner as Record<string, unknown>)) {
      if (v === "transform" || v === "style" || v === "text" || v === "3d" || v === "anchors")
        kept[ovId] = v;
    }
    if (Object.keys(kept).length > 0) out[pieceId] = kept;
  }
  return out;
}

export type RightRegionMode = "editor" | "onboarding" | "api-config";

export function sanitizeRightRegionMode(v: unknown): RightRegionMode {
  return v === "onboarding" || v === "api-config" || v === "editor" ? v : "editor";
}

/**
 * Coerce a PERSISTED mode for first load: `api-config` is meaningless across a
 * reload because its `apiConfigMcpId` is transient (lost on reload), so restoring
 * it would render an empty/generic config panel. Fall back to `editor` — the panel
 * is re-opened on demand by the agent via the `right_region` SSE event.
 */
function loadRightRegionMode(v: unknown): RightRegionMode {
  const mode = sanitizeRightRegionMode(v);
  return mode === "api-config" ? "editor" : mode;
}

/** Keep only `true` entries — false/garbage means "hidden", which is the default. */
// Layers panel docking is tri-state: a stored boolean is an explicit user
// choice (true=docked, false=undocked); ABSENT means "use the default", which
// is docked. So we must preserve explicit `false` (not drop it) — otherwise an
// undock would round-trip back to the docked default and couldn't be turned off.
function sanitizeDockedPieces(raw: Record<string, unknown>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "boolean") out[k] = v;
  }
  return out;
}

/** Keep only nested `true` entries — pieceId → overlayId → true. */
function sanitizeNestedFlagMap(
  raw: Record<string, unknown>,
): Record<string, Record<string, boolean>> {
  const out: Record<string, Record<string, boolean>> = {};
  for (const [pieceId, inner] of Object.entries(raw)) {
    if (!inner || typeof inner !== "object") continue;
    const kept: Record<string, boolean> = {};
    for (const [ovId, v] of Object.entries(inner as Record<string, unknown>)) {
      if (v === true) kept[ovId] = true;
    }
    if (Object.keys(kept).length > 0) out[pieceId] = kept;
  }
  return out;
}

/** Coerce a persisted effect phase into a valid value; junk → "in". */
function sanitizeEffectPhase(v: unknown): "in" | "out" | "loop" {
  return v === "out" || v === "loop" || v === "in" ? v : "in";
}

function loadState(): PersistedEditorState {
  if (typeof window === "undefined") return DEFAULTS;
  try {
    // Try new key first
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        chatVisible: parsed.chatVisible ?? DEFAULTS.chatVisible,
        resourcesVisible: parsed.resourcesVisible ?? DEFAULTS.resourcesVisible,
        panelSizes: {
          resources: parsed.panelSizes?.resources ?? DEFAULTS.panelSizes.resources,
          editor: parsed.panelSizes?.editor ?? DEFAULTS.panelSizes.editor,
          chat: parsed.panelSizes?.chat ?? DEFAULTS.panelSizes.chat,
        },
        snapEnabled:
          typeof parsed.snapEnabled === "boolean" ? parsed.snapEnabled : DEFAULTS.snapEnabled,
        previewQuality:
          parsed.previewQuality === "720p" || parsed.previewQuality === "auto"
            ? parsed.previewQuality
            : DEFAULTS.previewQuality,
        overlayInspectorModePieces:
          parsed.overlayInspectorModePieces &&
          typeof parsed.overlayInspectorModePieces === "object"
            ? sanitizeOverlayModeMap(parsed.overlayInspectorModePieces)
            : DEFAULTS.overlayInspectorModePieces,
        assetPanelSplit: parsed.assetPanelSplit ?? DEFAULTS.assetPanelSplit,
        assetViewModes:
          // Per-asset view-mode map. Older builds shipped a global `assetFullMode`
          // boolean which is no longer respected — we drop it on read so a
          // user who left full-mode on globally now defaults to split per-asset
          // (matching the new "split is the default UX" intent).
          parsed.assetViewModes && typeof parsed.assetViewModes === "object"
            ? sanitizeAssetViewModes(parsed.assetViewModes)
            : DEFAULTS.assetViewModes,
        lastPieceId:
          typeof parsed.lastPieceId === "string" ? parsed.lastPieceId : DEFAULTS.lastPieceId,
        lastEditorTab:
          parsed.lastEditorTab === "preview" ||
          parsed.lastEditorTab === "storyboard" ||
          parsed.lastEditorTab === "assets" ||
          parsed.lastEditorTab === "objects"
            ? parsed.lastEditorTab
            : DEFAULTS.lastEditorTab,
        lastAssetId:
          typeof parsed.lastAssetId === "string" ? parsed.lastAssetId : DEFAULTS.lastAssetId,
        lastAssetTab:
          parsed.lastAssetTab === "preview" ||
          parsed.lastAssetTab === "summary" ||
          parsed.lastAssetTab === "transcript" ||
          parsed.lastAssetTab === "frames" ||
          parsed.lastAssetTab === "script" ||
          parsed.lastAssetTab === "generation" ||
          parsed.lastAssetTab === "notes"
            ? parsed.lastAssetTab
            : DEFAULTS.lastAssetTab,
        scriptShotRailPct:
          typeof parsed.scriptShotRailPct === "number"
            ? parsed.scriptShotRailPct
            : DEFAULTS.scriptShotRailPct,
        previewTimelineSplit: clampSplit(parsed.previewTimelineSplit, DEFAULTS.previewTimelineSplit),
        effectsPanelHeight: clampEffectsHeight(parsed.effectsPanelHeight),
        previewTimelineZoom:
          typeof parsed.previewTimelineZoom === "number" && parsed.previewTimelineZoom > 0
            ? parsed.previewTimelineZoom
            : DEFAULTS.previewTimelineZoom,
        effectsPanelOpen:
          typeof parsed.effectsPanelOpen === "boolean"
            ? parsed.effectsPanelOpen
            : DEFAULTS.effectsPanelOpen,
        codexNudgeDismissed:
          typeof parsed.codexNudgeDismissed === "boolean"
            ? parsed.codexNudgeDismissed
            : DEFAULTS.codexNudgeDismissed,
        effectsLastPhase: sanitizeEffectPhase(parsed.effectsLastPhase),
        previewLayersSplit: clampSplit(parsed.previewLayersSplit, DEFAULTS.previewLayersSplit),
        previewLayersDockedPieces:
          parsed.previewLayersDockedPieces && typeof parsed.previewLayersDockedPieces === "object"
            ? sanitizeDockedPieces(parsed.previewLayersDockedPieces)
            : DEFAULTS.previewLayersDockedPieces,
        overlayLockedPieces:
          parsed.overlayLockedPieces && typeof parsed.overlayLockedPieces === "object"
            ? sanitizeNestedFlagMap(parsed.overlayLockedPieces)
            : DEFAULTS.overlayLockedPieces,
        overlaySizeSplitPieces:
          parsed.overlaySizeSplitPieces && typeof parsed.overlaySizeSplitPieces === "object"
            ? sanitizeNestedFlagMap(parsed.overlaySizeSplitPieces)
            : DEFAULTS.overlaySizeSplitPieces,
        lastSessionId:
          typeof parsed.lastSessionId === "string" ? parsed.lastSessionId : DEFAULTS.lastSessionId,
        terminalCliId:
          typeof parsed.terminalCliId === "string" && parsed.terminalCliId
            ? parsed.terminalCliId
            : DEFAULTS.terminalCliId,
        rightRegionMode: loadRightRegionMode(parsed.rightRegionMode),
      };
    }

    // Migrate from old key
    const oldRaw = localStorage.getItem(OLD_LAYOUT_KEY);
    if (oldRaw) {
      const old = JSON.parse(oldRaw);
      const migrated: PersistedEditorState = {
        chatVisible: old.chatVisible ?? DEFAULTS.chatVisible,
        resourcesVisible: old.resourcesVisible ?? DEFAULTS.resourcesVisible,
        panelSizes: {
          resources: old.resources ?? DEFAULTS.panelSizes.resources,
          editor: old.editor ?? DEFAULTS.panelSizes.editor,
          chat: old.chat ?? DEFAULTS.panelSizes.chat,
        },
        snapEnabled: DEFAULTS.snapEnabled,
        previewQuality: DEFAULTS.previewQuality,
        overlayInspectorModePieces: DEFAULTS.overlayInspectorModePieces,
        assetPanelSplit: DEFAULTS.assetPanelSplit,
        assetViewModes: DEFAULTS.assetViewModes,
        lastPieceId: DEFAULTS.lastPieceId,
        lastEditorTab: DEFAULTS.lastEditorTab,
        lastAssetId: DEFAULTS.lastAssetId,
        lastAssetTab: DEFAULTS.lastAssetTab,
        scriptShotRailPct: DEFAULTS.scriptShotRailPct,
        previewTimelineSplit: DEFAULTS.previewTimelineSplit,
        effectsPanelHeight: DEFAULTS.effectsPanelHeight,
        previewTimelineZoom: DEFAULTS.previewTimelineZoom,
        effectsPanelOpen: DEFAULTS.effectsPanelOpen,
        codexNudgeDismissed: DEFAULTS.codexNudgeDismissed,
        effectsLastPhase: DEFAULTS.effectsLastPhase,
        previewLayersSplit: DEFAULTS.previewLayersSplit,
        previewLayersDockedPieces: DEFAULTS.previewLayersDockedPieces,
        overlayLockedPieces: DEFAULTS.overlayLockedPieces,
        overlaySizeSplitPieces: DEFAULTS.overlaySizeSplitPieces,
        lastSessionId: DEFAULTS.lastSessionId,
        terminalCliId: DEFAULTS.terminalCliId,
        rightRegionMode: DEFAULTS.rightRegionMode,
      };
      saveState(migrated);
      localStorage.removeItem(OLD_LAYOUT_KEY);
      return migrated;
    }
  } catch {
    // ignore
  }
  return DEFAULTS;
}

function saveState(state: PersistedEditorState): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

// ── Context value ──────────────────────────────────────────────────────

interface EditorStateContextValue {
  // Panel visibility
  chatVisible: boolean;
  resourcesVisible: boolean;
  toggleChat: () => void;
  toggleResources: () => void;

  // View mode: "draft" shows the live manifest; "snapshot" shows the last committed snapshot.
  // Resets to "draft" whenever the active piece changes.
  viewMode: "draft" | "snapshot";
  setViewMode: (mode: "draft" | "snapshot") => void;

  // Panel sizes (percentages, always reflect the "stored" 3-panel split)
  panelSizes: { resources: number; editor: number; chat: number };
  setPanelSizes: (sizes: { resources: number; editor: number; chat: number }) => void;

  // Point-text canvas snapping toggle (preview toolbar). Default ON.
  snapEnabled: boolean;
  setSnapEnabled: (value: boolean) => void;

  // Preview decode quality (per-device performance pref; Settings → General).
  previewQuality: PreviewQuality;
  setPreviewQuality: (value: PreviewQuality) => void;

  // Per-overlay inspector tab (intent group).
  // - getOverlayInspectorMode: stored group if available for the kind, else the
  //   kind's default group (clamps stale tier values too).
  // - setOverlayInspectorMode: persists into the nested map.
  getOverlayInspectorMode: (
    pieceId: string,
    overlayId: string,
    kind: InspectorOverlayKind,
  ) => InspectorGroup;
  setOverlayInspectorMode: (
    pieceId: string,
    overlayId: string,
    mode: InspectorGroup,
  ) => void;

  // Asset preview panel state.
  // - `assetPanelSplit` is shared across all assets (top-section %).
  // - `getAssetViewMode(id)` / `setAssetViewMode(id, mode)` is per-asset.
  //   Default is `"split"` when the asset has never been toggled.
  assetPanelSplit: number;
  setAssetPanelSplit: (value: number) => void;
  getAssetViewMode: (fileId: string) => "split" | "full";
  setAssetViewMode: (fileId: string, mode: "split" | "full") => void;

  // "Last opened" snapshot — used to restore the editor state on the next
  // visit. Read on mount; written whenever the user moves around so the
  // restore-on-load logic always has a fresh anchor.
  lastPieceId: string | null;
  setLastPieceId: (id: string | null) => void;
  lastEditorTab: "preview" | "storyboard" | "assets" | "objects";
  setLastEditorTab: (tab: "preview" | "storyboard" | "assets" | "objects") => void;
  lastAssetId: string | null;
  setLastAssetId: (id: string | null) => void;
  lastAssetTab: "preview" | "summary" | "transcript" | "frames" | "script" | "generation" | "notes";
  setLastAssetTab: (
    tab: "preview" | "summary" | "transcript" | "frames" | "script" | "generation" | "notes",
  ) => void;
  scriptShotRailPct: number;
  setScriptShotRailPct: (value: number) => void;

  previewTimelineSplit: number;
  setPreviewTimelineSplit: (value: number) => void;
  effectsPanelHeight: number;
  setEffectsPanelHeight: (value: number) => void;
  previewTimelineZoom: number | null;
  setPreviewTimelineZoom: (value: number | null) => void;
  effectsPanelOpen: boolean;
  setEffectsPanelOpen: (value: boolean) => void;
  codexNudgeDismissed: boolean;
  setCodexNudgeDismissed: (value: boolean) => void;
  effectsLastPhase: "in" | "out" | "loop";
  setEffectsLastPhase: (value: "in" | "out" | "loop") => void;
  previewLayersSplit: number;
  setPreviewLayersSplit: (value: number) => void;
  getPreviewLayersDocked: (pieceId: string) => boolean;
  setPreviewLayersDocked: (pieceId: string, docked: boolean) => void;
  getOverlayLocked: (pieceId: string, overlayId: string) => boolean;
  setOverlayLocked: (pieceId: string, overlayId: string, locked: boolean) => void;
  getOverlaySizeSplit: (pieceId: string, overlayId: string) => boolean;
  setOverlaySizeSplit: (pieceId: string, overlayId: string, split: boolean) => void;

  /** When non-null, ChatPanel consumes this on mount/update by setting its
   *  composer input value, then calls setPrefilledMessage(null) to clear it.
   *  Used by buttons like the Script tab's "Ask AI to generate". */
  prefilledMessage: string | null;
  setPrefilledMessage: (text: string | null) => void;

  lastSessionId: string | null;
  setLastSessionId: (id: string | null) => void;

  // Terminal surface state.
  // - `terminalCliId` (persisted): the "Launch CLI" preset for NEW terminals.
  // - `activeTerminalId` (in-memory): which live terminal the panel shows.
  //   Not persisted — terminal sessions don't survive a server restart.
  terminalCliId: string;
  setTerminalCliId: (id: string) => void;
  activeTerminalId: string | null;
  setActiveTerminalId: (id: string | null) => void;

  // Asset folder explorer state (in-memory only — not persisted)
  assetCurrentFolderId: string | null;
  setAssetCurrentFolderId: (id: string | null) => void;
  assetOriginFolderId: string | null;
  setAssetOriginFolderId: (id: string | null) => void;

  // Right region mode (persisted) + inline API-config panel state (transient).
  rightRegionMode: RightRegionMode;
  setRightRegionMode: (mode: RightRegionMode) => void;
  /** The MCP id to configure inline. Transient — not persisted. Null when no panel is open. */
  apiConfigMcpId: string | null;
  setApiConfigMcpId: (id: string | null) => void;
  /** First-run flag: true when the user should see the one-tap "Show me how
   *  it works" demo suggestion. In-memory here, but not purely
   *  client-state: it's seeded from the server (armed by
   *  lib/sessions/session-manager.ts#markAgentConnected on first agent
   *  connect, so a reload before the user acts on it doesn't lose it),
   *  re-read the moment `sessionList.readiness` reaches "ready" later in the
   *  same session (a real connection, never just an agent *selection* — see
   *  the effect below), and `setOnboardingDemoOffer(false)` persists that
   *  resolution (dismissed OR taken; the chip treats both the same) back to
   *  the server so it never returns. */
  onboardingDemoOffer: boolean;
  setOnboardingDemoOffer: (v: boolean) => void;

  // Agent provider
  agentProviders: ProviderInfo[];
  agentProvidersLoaded: boolean;
  activeProviderId: string | null;
  isAgentConnecting: boolean;
  /**
   * Switch to an agent. Resolves with what the server learned about it during
   * the switch — `needs-auth` carries the sign-in remedy resolved on THIS
   * machine — or null when the response said nothing useful. Callers that
   * only want the side effect can keep ignoring the result.
   */
  selectAgent: (providerId: string) => Promise<AgentReadiness | null>;
  refreshAgentProviders: () => void;

  // Session list (shared across the app so the sidebar is identical on every page)
  sessionList: UseSessionList;
}

const EditorStateContext = createContext<EditorStateContextValue | null>(null);

// ── Provider ───────────────────────────────────────────────────────────

export function EditorStateProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const sessionList = useSessionList();

  const [chatVisible, setChatVisible] = useState(() => loadState().chatVisible);
  const [resourcesVisible, setResourcesVisible] = useState(() => loadState().resourcesVisible);
  const [panelSizes, setPanelSizesState] = useState(() => loadState().panelSizes);
  const [snapEnabled, setSnapEnabledState] = useState(() => loadState().snapEnabled);
  const [previewQuality, setPreviewQualityState] = useState(() => loadState().previewQuality);
  const [overlayInspectorModePieces, setOverlayInspectorModePiecesState] = useState(
    () => loadState().overlayInspectorModePieces,
  );
  const [assetPanelSplit, setAssetPanelSplitState] = useState(() => loadState().assetPanelSplit);
  const [assetViewModes, setAssetViewModesState] = useState(() => loadState().assetViewModes);
  const [lastPieceId, setLastPieceIdState] = useState<string | null>(() => loadState().lastPieceId);
  const [lastEditorTab, setLastEditorTabState] = useState(() => loadState().lastEditorTab);
  const [lastAssetId, setLastAssetIdState] = useState<string | null>(() => loadState().lastAssetId);
  const [lastAssetTab, setLastAssetTabState] = useState(() => loadState().lastAssetTab);
  const [scriptShotRailPct, setScriptShotRailPctState] = useState(
    () => loadState().scriptShotRailPct,
  );
  const [previewTimelineSplit, setPreviewTimelineSplitState] = useState(
    () => loadState().previewTimelineSplit,
  );
  const [effectsPanelHeight, setEffectsPanelHeightState] = useState(
    () => loadState().effectsPanelHeight,
  );
  const [previewTimelineZoom, setPreviewTimelineZoomState] = useState<number | null>(
    () => loadState().previewTimelineZoom,
  );
  const [effectsPanelOpen, setEffectsPanelOpenState] = useState(
    () => loadState().effectsPanelOpen,
  );
  const [codexNudgeDismissed, setCodexNudgeDismissedState] = useState(
    () => loadState().codexNudgeDismissed,
  );
  const [effectsLastPhase, setEffectsLastPhaseState] = useState<"in" | "out" | "loop">(
    () => loadState().effectsLastPhase,
  );
  const [previewLayersSplit, setPreviewLayersSplitState] = useState(
    () => loadState().previewLayersSplit,
  );
  const [previewLayersDockedPieces, setPreviewLayersDockedPiecesState] = useState(
    () => loadState().previewLayersDockedPieces,
  );
  const [overlayLockedPieces, setOverlayLockedPiecesState] = useState(
    () => loadState().overlayLockedPieces,
  );
  const [overlaySizeSplitPieces, setOverlaySizeSplitPiecesState] = useState(
    () => loadState().overlaySizeSplitPieces,
  );
  const [prefilledMessage, setPrefilledMessageState] = useState<string | null>(null);
  const [lastSessionId, setLastSessionIdState] = useState<string | null>(() => loadState().lastSessionId);
  const [terminalCliId, setTerminalCliIdState] = useState(() => loadState().terminalCliId);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [rightRegionMode, setRightRegionModeState] = useState<RightRegionMode>(
    () => loadState().rightRegionMode,
  );
  const rightRegionModeRef = useRef(rightRegionMode);
  rightRegionModeRef.current = rightRegionMode;
  const [apiConfigMcpId, setApiConfigMcpId] = useState<string | null>(null);

  // ── Onboarding demo offer (Task 13) ─────────────────────────────────
  //
  // Deliberately plain `fetch`, NOT React Query — same reasoning as
  // `agentProviders` just above (see lib/queries/agent-setup.ts's header
  // comment): EditorStateProvider is rendered without a QueryClientProvider
  // ancestor across a couple dozen existing tests, and there is no other
  // consumer of this specific read/write pair to share a cache with.
  //
  // `onboardingDemoOffer` starts false and is SEEDED true by a one-shot GET
  // of /api/onboarding/state on mount, when the server reports the offer
  // was armed (first agent connect — session-manager's markAgentConnected)
  // and not yet resolved. That single fetch is what fixes the reload bug:
  // previously this was a bare `useState(false)`, armed only by a
  // client-side effect (page.tsx) that fires once per session and never
  // again — a reload before the user acted on it lost the offer for good.
  const [onboardingDemoOffer, setOnboardingDemoOfferState] = useState(false);
  useEffect(() => {
    fetch("/api/onboarding/state")
      .then((r) => r.json())
      .then((data: { demoOffered?: boolean }) => {
        if (data.demoOffered) setOnboardingDemoOfferState(true);
      })
      .catch(() => {});
  }, []);

  // Re-read the same endpoint once a connection has ACTUALLY succeeded, so
  // the offer can still appear later in the same session (not only on
  // reload). `sessionList.readiness` reaching "ready" is the client-visible
  // mirror of the exact server event that arms the offer
  // (session-manager.ts#markAgentReady / #markAgentConnected both fire off
  // the same clean `session/new`) — unlike `activeProviderId`, which flips
  // the moment an agent is merely SELECTED, before the handshake resolves or
  // fails. Keyed on the primitive `.state`, not the readiness object, so this
  // only re-fires on a genuine transition (e.g. unknown/needs-auth → ready),
  // never once per render. Server truth for `demoOffered` already folds in
  // `onboardingDemoDismissedAt`, so re-reading it can only ever affirm or
  // stay silent — it cannot re-arm an offer the user already dismissed.
  // Optional chaining: several existing test doubles for useSessionList
  // predate the `readiness` field and omit it — the real hook always
  // supplies it, but an incomplete mock must read as "not ready" rather
  // than throw.
  const readinessState = sessionList.readiness?.state;
  useEffect(() => {
    if (readinessState !== "ready") return;
    fetch("/api/onboarding/state")
      .then((r) => r.json())
      .then((data: { demoOffered?: boolean }) => {
        if (data.demoOffered) setOnboardingDemoOfferState(true);
      })
      .catch(() => {});
  }, [readinessState]);

  // Persists the resolution (dismissed OR taken — the chip treats both the
  // same) whenever the offer is cleared, so it never reappears after a
  // reload. Callers (chat-panel.tsx, terminal-panel.tsx) are unchanged —
  // they already just call `setOnboardingDemoOffer(false)`. Fire-and-forget:
  // a failed write only risks the chip resurfacing next session, never a
  // broken UI now.
  const setOnboardingDemoOffer = useCallback((v: boolean) => {
    setOnboardingDemoOfferState(v);
    if (!v) {
      fetch("/api/onboarding/state", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dismissDemoOffer: true }),
      }).catch(() => {});
    }
  }, []);

  // viewMode is not persisted — it always starts as "draft" and resets to
  // "draft" whenever the active piece changes so the user never sees stale
  // snapshot data for a different piece.
  const [viewMode, setViewModeState] = useState<"draft" | "snapshot">("draft");

  // Asset folder explorer state (in-memory only — not persisted)
  const [assetCurrentFolderId, setAssetCurrentFolderId] = useState<string | null>(null);
  const [assetOriginFolderId, setAssetOriginFolderId] = useState<string | null>(null);

  // Keep refs in sync for cross-field reads during toggle callbacks
  const chatVisibleRef = useRef(chatVisible);
  chatVisibleRef.current = chatVisible;
  const resourcesVisibleRef = useRef(resourcesVisible);
  resourcesVisibleRef.current = resourcesVisible;
  const panelSizesRef = useRef(panelSizes);
  panelSizesRef.current = panelSizes;
  const snapEnabledRef = useRef(snapEnabled);
  snapEnabledRef.current = snapEnabled;
  const previewQualityRef = useRef(previewQuality);
  previewQualityRef.current = previewQuality;
  const overlayInspectorModePiecesRef = useRef(overlayInspectorModePieces);
  overlayInspectorModePiecesRef.current = overlayInspectorModePieces;
  const assetPanelSplitRef = useRef(assetPanelSplit);
  assetPanelSplitRef.current = assetPanelSplit;
  const assetViewModesRef = useRef(assetViewModes);
  assetViewModesRef.current = assetViewModes;
  const lastPieceIdRef = useRef(lastPieceId);
  lastPieceIdRef.current = lastPieceId;
  const lastEditorTabRef = useRef(lastEditorTab);
  lastEditorTabRef.current = lastEditorTab;
  const lastAssetIdRef = useRef(lastAssetId);
  lastAssetIdRef.current = lastAssetId;
  const lastAssetTabRef = useRef(lastAssetTab);
  lastAssetTabRef.current = lastAssetTab;
  const scriptShotRailPctRef = useRef(scriptShotRailPct);
  scriptShotRailPctRef.current = scriptShotRailPct;
  const previewTimelineSplitRef = useRef(previewTimelineSplit);
  previewTimelineSplitRef.current = previewTimelineSplit;
  const effectsPanelHeightRef = useRef(effectsPanelHeight);
  effectsPanelHeightRef.current = effectsPanelHeight;
  const previewTimelineZoomRef = useRef(previewTimelineZoom);
  previewTimelineZoomRef.current = previewTimelineZoom;
  const effectsPanelOpenRef = useRef(effectsPanelOpen);
  effectsPanelOpenRef.current = effectsPanelOpen;
  const codexNudgeDismissedRef = useRef(codexNudgeDismissed);
  codexNudgeDismissedRef.current = codexNudgeDismissed;
  const effectsLastPhaseRef = useRef(effectsLastPhase);
  effectsLastPhaseRef.current = effectsLastPhase;
  const previewLayersSplitRef = useRef(previewLayersSplit);
  previewLayersSplitRef.current = previewLayersSplit;
  const previewLayersDockedPiecesRef = useRef(previewLayersDockedPieces);
  previewLayersDockedPiecesRef.current = previewLayersDockedPieces;
  const overlayLockedPiecesRef = useRef(overlayLockedPieces);
  overlayLockedPiecesRef.current = overlayLockedPieces;
  const overlaySizeSplitPiecesRef = useRef(overlaySizeSplitPieces);
  overlaySizeSplitPiecesRef.current = overlaySizeSplitPieces;
  const lastSessionIdRef = useRef(lastSessionId);
  lastSessionIdRef.current = lastSessionId;
  const terminalCliIdRef = useRef(terminalCliId);
  terminalCliIdRef.current = terminalCliId;

  // Reset viewMode to "draft" whenever the active piece changes so a stale
  // snapshot view from the previous piece never bleeds into the new one.
  useEffect(() => {
    setViewModeState("draft");
  }, [lastPieceId]);

  const setViewMode = useCallback((mode: "draft" | "snapshot") => {
    setViewModeState(mode);
  }, []);

  const persist = useCallback(() => {
    saveState({
      chatVisible: chatVisibleRef.current,
      resourcesVisible: resourcesVisibleRef.current,
      panelSizes: panelSizesRef.current,
      snapEnabled: snapEnabledRef.current,
      previewQuality: previewQualityRef.current,
      overlayInspectorModePieces: overlayInspectorModePiecesRef.current,
      assetPanelSplit: assetPanelSplitRef.current,
      assetViewModes: assetViewModesRef.current,
      lastPieceId: lastPieceIdRef.current,
      lastEditorTab: lastEditorTabRef.current,
      lastAssetId: lastAssetIdRef.current,
      lastAssetTab: lastAssetTabRef.current,
      scriptShotRailPct: scriptShotRailPctRef.current,
      previewTimelineSplit: previewTimelineSplitRef.current,
      effectsPanelHeight: effectsPanelHeightRef.current,
      previewTimelineZoom: previewTimelineZoomRef.current,
      effectsPanelOpen: effectsPanelOpenRef.current,
      codexNudgeDismissed: codexNudgeDismissedRef.current,
      effectsLastPhase: effectsLastPhaseRef.current,
      previewLayersSplit: previewLayersSplitRef.current,
      previewLayersDockedPieces: previewLayersDockedPiecesRef.current,
      overlayLockedPieces: overlayLockedPiecesRef.current,
      overlaySizeSplitPieces: overlaySizeSplitPiecesRef.current,
      lastSessionId: lastSessionIdRef.current,
      terminalCliId: terminalCliIdRef.current,
      rightRegionMode: rightRegionModeRef.current,
    });
  }, []);

  const toggleChat = useCallback(() => {
    setChatVisible((prev) => {
      const next = !prev;
      chatVisibleRef.current = next;
      persist();
      return next;
    });
  }, [persist]);

  const toggleResources = useCallback(() => {
    setResourcesVisible((prev) => {
      const next = !prev;
      resourcesVisibleRef.current = next;
      persist();
      return next;
    });
  }, [persist]);

  const setPanelSizes = useCallback((sizes: { resources: number; editor: number; chat: number }) => {
    setPanelSizesState(sizes);
    panelSizesRef.current = sizes;
    persist();
  }, [persist]);

  const setSnapEnabled = useCallback((value: boolean) => {
    setSnapEnabledState(value);
    snapEnabledRef.current = value;
    persist();
  }, [persist]);

  const setPreviewQuality = useCallback((value: PreviewQuality) => {
    setPreviewQualityState(value);
    previewQualityRef.current = value;
    persist();
  }, [persist]);

  const getOverlayInspectorMode = useCallback(
    (
      pieceId: string,
      overlayId: string,
      kind: InspectorOverlayKind,
    ): InspectorGroup => {
      const stored = overlayInspectorModePiecesRef.current[pieceId]?.[overlayId];
      // Stale tier values ("simple"/"advanced"/"expert") or a group not valid
      // for this kind clamp to the kind's default group.
      if (stored && groupsForKind(kind).includes(stored as InspectorGroup)) {
        return stored as InspectorGroup;
      }
      return defaultGroupForKind(kind);
    },
    [],
  );

  const setOverlayInspectorMode = useCallback(
    (pieceId: string, overlayId: string, mode: InspectorGroup) => {
      const next = { ...overlayInspectorModePiecesRef.current };
      const inner = { ...(next[pieceId] ?? {}) };
      inner[overlayId] = mode;
      next[pieceId] = inner;
      overlayInspectorModePiecesRef.current = next;
      setOverlayInspectorModePiecesState(next);
      persist();
    },
    [persist],
  );

  const setAssetPanelSplit = useCallback((value: number) => {
    setAssetPanelSplitState(value);
    assetPanelSplitRef.current = value;
    persist();
  }, [persist]);

  const getAssetViewMode = useCallback(
    (fileId: string): "split" | "full" =>
      assetViewModesRef.current[fileId] ?? "split",
    [],
  );

  const setAssetViewMode = useCallback(
    (fileId: string, mode: "split" | "full") => {
      // Identity-stable update: drop the entry if it matches the default
      // ("split"), so the persisted blob stays small and a deleted file's
      // entry can be cleaned up by a future toggle. Other entries are
      // preserved so per-asset preferences survive.
      //
      // We compute `next` from the ref (stays in sync via the assignment
      // below) instead of via the setState updater so `persist()` reads
      // the new value, not the stale pre-update one.
      const next = { ...assetViewModesRef.current };
      if (mode === "split") delete next[fileId];
      else next[fileId] = mode;
      assetViewModesRef.current = next;
      setAssetViewModesState(next);
      persist();
    },
    [persist],
  );

  const setLastPieceId = useCallback(
    (id: string | null) => {
      lastPieceIdRef.current = id;
      setLastPieceIdState(id);
      persist();
    },
    [persist],
  );

  const setLastEditorTab = useCallback(
    (tab: "preview" | "storyboard" | "assets" | "objects") => {
      lastEditorTabRef.current = tab;
      setLastEditorTabState(tab);
      persist();
    },
    [persist],
  );

  const setLastAssetId = useCallback(
    (id: string | null) => {
      lastAssetIdRef.current = id;
      setLastAssetIdState(id);
      persist();
    },
    [persist],
  );

  const setLastAssetTab = useCallback(
    (tab: "preview" | "summary" | "transcript" | "frames" | "script" | "generation" | "notes") => {
      lastAssetTabRef.current = tab;
      setLastAssetTabState(tab);
      persist();
    },
    [persist],
  );

  const setScriptShotRailPct = useCallback((value: number) => {
    setScriptShotRailPctState(value);
    scriptShotRailPctRef.current = value;
    persist();
  }, [persist]);

  const setPreviewTimelineSplit = useCallback((value: number) => {
    setPreviewTimelineSplitState(value);
    previewTimelineSplitRef.current = value;
    persist();
  }, [persist]);

  const setEffectsPanelHeight = useCallback((value: number) => {
    const v = clampEffectsHeight(value);
    effectsPanelHeightRef.current = v;
    setEffectsPanelHeightState(v);
    persist();
  }, [persist]);

  const setPreviewTimelineZoom = useCallback((value: number | null) => {
    setPreviewTimelineZoomState(value);
    previewTimelineZoomRef.current = value;
    persist();
  }, [persist]);

  const setEffectsPanelOpen = useCallback((value: boolean) => {
    setEffectsPanelOpenState(value);
    effectsPanelOpenRef.current = value;
    persist();
  }, [persist]);

  const setCodexNudgeDismissed = useCallback((value: boolean) => {
    setCodexNudgeDismissedState(value);
    codexNudgeDismissedRef.current = value;
    persist();
  }, [persist]);

  const setEffectsLastPhase = useCallback((value: "in" | "out" | "loop") => {
    setEffectsLastPhaseState(value);
    effectsLastPhaseRef.current = value;
    persist();
  }, [persist]);

  const setPreviewLayersSplit = useCallback((value: number) => {
    setPreviewLayersSplitState(value);
    previewLayersSplitRef.current = value;
    persist();
  }, [persist]);

  const getPreviewLayersDocked = useCallback(
    // Default HIDDEN: absent (no explicit choice) ⇒ not docked. New users get a
    // focused layout — each new piece starts with the layers panel closed. This
    // flag is per-piece (a user's choice does not carry to future new pieces);
    // an explicit `true` docks it for that piece.
    (pieceId: string): boolean => previewLayersDockedPiecesRef.current[pieceId] ?? false,
    [],
  );
  const setPreviewLayersDocked = useCallback(
    (pieceId: string, docked: boolean) => {
      // Store the explicit boolean (don't delete on false) so an undock sticks.
      const next = { ...previewLayersDockedPiecesRef.current, [pieceId]: docked };
      previewLayersDockedPiecesRef.current = next;
      setPreviewLayersDockedPiecesState(next);
      persist();
    },
    [persist],
  );

  // Nested-map setter: pieceId → overlayId → true. Drops empty inners so a
  // deleted overlay/piece doesn't leak into the persisted blob.
  const setNestedFlag = useCallback(
    (
      ref: MutableRefObject<Record<string, Record<string, boolean>>>,
      setState: (v: Record<string, Record<string, boolean>>) => void,
      pieceId: string,
      overlayId: string,
      on: boolean,
    ) => {
      const next = { ...ref.current };
      const inner = { ...(next[pieceId] ?? {}) };
      if (on) inner[overlayId] = true;
      else delete inner[overlayId];
      if (Object.keys(inner).length > 0) next[pieceId] = inner;
      else delete next[pieceId];
      ref.current = next;
      setState(next);
      persist();
    },
    [persist],
  );

  const getOverlayLocked = useCallback(
    (pieceId: string, overlayId: string): boolean =>
      overlayLockedPiecesRef.current[pieceId]?.[overlayId] === true,
    [],
  );
  const setOverlayLocked = useCallback(
    (pieceId: string, overlayId: string, locked: boolean) =>
      setNestedFlag(overlayLockedPiecesRef, setOverlayLockedPiecesState, pieceId, overlayId, locked),
    [setNestedFlag],
  );
  const getOverlaySizeSplit = useCallback(
    (pieceId: string, overlayId: string): boolean =>
      overlaySizeSplitPiecesRef.current[pieceId]?.[overlayId] === true,
    [],
  );
  const setOverlaySizeSplit = useCallback(
    (pieceId: string, overlayId: string, split: boolean) =>
      setNestedFlag(
        overlaySizeSplitPiecesRef,
        setOverlaySizeSplitPiecesState,
        pieceId,
        overlayId,
        split,
      ),
    [setNestedFlag],
  );

  const setPrefilledMessage = useCallback((text: string | null) => {
    setPrefilledMessageState(text);
  }, []);

  const setLastSessionId = useCallback(
    (id: string | null) => {
      lastSessionIdRef.current = id;
      setLastSessionIdState(id);
      persist();
    },
    [persist],
  );

  const setTerminalCliId = useCallback(
    (id: string) => {
      terminalCliIdRef.current = id;
      setTerminalCliIdState(id);
      persist();
    },
    [persist],
  );

  const setRightRegionMode = useCallback(
    (mode: RightRegionMode) => {
      setRightRegionModeState(mode);
      rightRegionModeRef.current = mode;
      persist();
    },
    [persist],
  );

  // ── Agent state ──────────────────────────────────────────────────────
  //
  // Two pieces of state:
  //   1. `agentProviders` — installed-CLI detection from /api/agent/providers.
  //      Effectively static (doesn't change unless the user installs a CLI
  //      and clicks "Re-detect agents"), so we fetch once on mount.
  //   2. `pendingProviderId` — set while selectAgent() is in flight so the UI
  //      shows the in-flight target before the server confirms. Cleared once
  //      the request resolves; from then on we read from `sessionList.activeAgentId`.
  //
  // The active agent itself is NOT stored locally — it lives on the server
  // (SessionManager._activeAgentId) and reaches us via useSessionList.

  const [agentProviders, setAgentProviders] = useState<ProviderInfo[]>([]);
  const [agentProvidersLoaded, setAgentProvidersLoaded] = useState(false);
  const [pendingProviderId, setPendingProviderId] = useState<string | null>(null);

  const fetchAgentProviders = useCallback((refresh = false) => {
    const url = refresh ? "/api/agent/providers?refresh=true" : "/api/agent/providers";
    fetch(url)
      .then((r) => r.json())
      .then((data: ProviderInfo[]) => {
        setAgentProviders(data);
        setAgentProvidersLoaded(true);
      })
      .catch(() => {});
  }, []);

  // Pending overrides server truth while selectAgent is in flight; otherwise
  // the dropdown reflects what the server actually has warmed.
  const activeProviderId = pendingProviderId ?? sessionList.activeAgentId;
  const isAgentConnecting = pendingProviderId !== null;

  const sessionListRefresh = sessionList.refresh;
  const selectAgent = useCallback(
    async (providerId: string): Promise<AgentReadiness | null> => {
      setPendingProviderId(providerId);
      try {
        const res = await fetch("/api/agent/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ providerId }),
        });
        if (!res.ok) {
          const json = await res.json().catch(() => ({}));
          throw new Error((json as { error?: string }).error ?? `Start failed (${res.status})`);
        }
        // The body already carries the readiness this switch observed — it was
        // being parsed nowhere and thrown away, which is why the sign-in card
        // had no way to act on "it needs auth, and here is the command".
        const body = (await res.json().catch(() => ({}))) as {
          readiness?: AgentReadiness;
        };
        // Kick a refetch so the server's activeAgentId catches up. We do NOT
        // clear `pendingProviderId` here: `/api/agent/start` returns BEFORE
        // `switchAgent` finishes (it's fire-and-forget server-side), so at
        // this point `activeAgentId` is still the previous/mid-switch agent.
        // Clearing now would drop the selector label back onto that stale
        // value and flicker it through intermediate agents before settling.
        // The confirm effect below clears the override once the server
        // reports the switch is complete.
        sessionListRefresh();
        return body.readiness ?? null;
      } catch (err) {
        // The switch failed to even start — drop the optimistic override so
        // the selector reverts to the real server agent.
        setPendingProviderId(null);
        throw err;
      }
    },
    [sessionListRefresh],
  );

  // Clear the optimistic override once the server confirms the switch
  // (activeAgentId caught up to the pending target). Holding it until then
  // pins the selector label to the chosen agent across the async warmup
  // instead of flickering through the mid-switch server activeAgentId.
  useEffect(() => {
    if (
      pendingProviderId !== null &&
      sessionList.activeAgentId === pendingProviderId
    ) {
      setPendingProviderId(null);
    }
  }, [pendingProviderId, sessionList.activeAgentId]);

  // Safety net: if the server never confirms (switch failed silently, or no
  // refetch delivered the new activeAgentId), drop the override after a grace
  // period so the selector can't stick in a "connecting" state forever.
  useEffect(() => {
    if (pendingProviderId === null) return;
    const timer = setTimeout(() => setPendingProviderId(null), 15000);
    return () => clearTimeout(timer);
  }, [pendingProviderId]);

  // Fetch providers on mount
  useEffect(() => {
    fetchAgentProviders();
  }, [fetchAgentProviders]);

  // Listen for `navigate_settings` events from libi.show_mcp_settings tool.
  // MUST go through the shared singleton EventSource (subscribeBroadcast),
  // not its own `new EventSource(...)` — EditorStateProvider lives at the
  // `(app)` layout and is permanently mounted, so a dedicated connection
  // here would squat on a browser HTTP/1.1 socket forever and contribute
  // to the Chrome 6-per-origin limit that hangs in-dev navigation.
  useEffect(() => {
    return subscribeBroadcast((data) => {
      if (data.type !== "navigate_settings") return;
      const mcpId = typeof data.mcpId === "string" ? data.mcpId : undefined;
      if (typeof window === "undefined") return;
      if (window.location.pathname !== "/mcps-skills") {
        router.push("/mcps-skills?tab=mcp");
      }
      window.dispatchEvent(
        new CustomEvent("libi:mcp-scroll-to", { detail: { mcpId } }),
      );
    });
  }, [router]);

  // Listen for `right_region` broadcast events from the server.
  // Updates rightRegionMode and apiConfigMcpId in response to MCP tool calls
  // (e.g. libi.show_onboarding, libi.show_mcp_settings inline).
  useEffect(() => {
    return subscribeBroadcast((data) => {
      if (data.type !== "right_region") return;
      const mode = sanitizeRightRegionMode(data.mode);
      setApiConfigMcpId(mode === "api-config" ? ((data.mcpId as string) ?? null) : null);
      setRightRegionMode(mode);
    });
  }, [setRightRegionMode]);

  // Stabilize derived values + the context value itself. Every consumer of
  // useEditorState() re-renders when the context value's identity changes,
  // so anything we hand over here must be referentially stable across
  // unrelated re-renders (e.g. parent state churn, SSE pings).
  // NOTE: this list is NOT filtered on `available`. Filtering here is what
  // made Claude Code VANISH from the selector during its first-boot runtime
  // install, with the explanation reaching only ~/.libi/logs/libi.log. The
  // selector renders unavailable agents disabled with their
  // `unavailableReason`; consumers that want only selectable agents filter on
  // `available` themselves.
  const refreshAgentProviders = useCallback(
    () => fetchAgentProviders(true),
    [fetchAgentProviders],
  );

  const value = useMemo(
    () => ({
      chatVisible,
      resourcesVisible,
      toggleChat,
      toggleResources,
      viewMode,
      setViewMode,
      panelSizes,
      setPanelSizes,
      snapEnabled,
      setSnapEnabled,
      previewQuality,
      setPreviewQuality,
      getOverlayInspectorMode,
      setOverlayInspectorMode,
      assetPanelSplit,
      setAssetPanelSplit,
      getAssetViewMode,
      setAssetViewMode,
      lastPieceId,
      setLastPieceId,
      lastEditorTab,
      setLastEditorTab,
      lastAssetId,
      setLastAssetId,
      lastAssetTab,
      setLastAssetTab,
      scriptShotRailPct,
      setScriptShotRailPct,
      previewTimelineSplit,
      setPreviewTimelineSplit,
      effectsPanelHeight,
      setEffectsPanelHeight,

      previewTimelineZoom,
      setPreviewTimelineZoom,
      effectsPanelOpen,
      setEffectsPanelOpen,
      codexNudgeDismissed,
      setCodexNudgeDismissed,
      effectsLastPhase,
      setEffectsLastPhase,
      previewLayersSplit,
      setPreviewLayersSplit,
      getPreviewLayersDocked,
      setPreviewLayersDocked,
      getOverlayLocked,
      setOverlayLocked,
      getOverlaySizeSplit,
      setOverlaySizeSplit,
      prefilledMessage,
      setPrefilledMessage,
      lastSessionId,
      setLastSessionId,
      terminalCliId,
      setTerminalCliId,
      activeTerminalId,
      setActiveTerminalId,
      assetCurrentFolderId,
      setAssetCurrentFolderId,
      assetOriginFolderId,
      setAssetOriginFolderId,
      rightRegionMode,
      setRightRegionMode,
      apiConfigMcpId,
      setApiConfigMcpId,
      onboardingDemoOffer,
      setOnboardingDemoOffer,
      agentProviders,
      agentProvidersLoaded,
      activeProviderId,
      isAgentConnecting,
      selectAgent,
      refreshAgentProviders,
      sessionList,
    }),
    [
      chatVisible,
      resourcesVisible,
      toggleChat,
      toggleResources,
      viewMode,
      setViewMode,
      panelSizes,
      setPanelSizes,
      snapEnabled,
      setSnapEnabled,
      previewQuality,
      setPreviewQuality,
      overlayInspectorModePieces, // re-render consumers when any per-overlay mode changes
      getOverlayInspectorMode,
      setOverlayInspectorMode,
      assetPanelSplit,
      setAssetPanelSplit,
      assetViewModes, // re-render consumers when any per-asset mode changes
      getAssetViewMode,
      setAssetViewMode,
      lastPieceId,
      setLastPieceId,
      lastEditorTab,
      setLastEditorTab,
      lastAssetId,
      setLastAssetId,
      lastAssetTab,
      setLastAssetTab,
      scriptShotRailPct,
      setScriptShotRailPct,
      previewTimelineSplit,
      setPreviewTimelineSplit,
      effectsPanelHeight,
      setEffectsPanelHeight,

      previewTimelineZoom,
      setPreviewTimelineZoom,
      effectsPanelOpen,
      setEffectsPanelOpen,
      codexNudgeDismissed,
      setCodexNudgeDismissed,
      effectsLastPhase,
      setEffectsLastPhase,
      previewLayersSplit,
      setPreviewLayersSplit,
      previewLayersDockedPieces,
      getPreviewLayersDocked,
      setPreviewLayersDocked,
      overlayLockedPieces,
      overlaySizeSplitPieces,
      getOverlayLocked,
      setOverlayLocked,
      getOverlaySizeSplit,
      setOverlaySizeSplit,
      prefilledMessage,
      setPrefilledMessage,
      lastSessionId,
      setLastSessionId,
      terminalCliId,
      setTerminalCliId,
      activeTerminalId,
      setActiveTerminalId,
      assetCurrentFolderId,
      setAssetCurrentFolderId,
      assetOriginFolderId,
      setAssetOriginFolderId,
      rightRegionMode,
      setRightRegionMode,
      apiConfigMcpId,
      setApiConfigMcpId,
      onboardingDemoOffer,
      setOnboardingDemoOffer,
      agentProviders,
      agentProvidersLoaded,
      activeProviderId,
      isAgentConnecting,
      selectAgent,
      refreshAgentProviders,
      sessionList,
    ],
  );

  return (
    <EditorStateContext.Provider value={value}>
      {children}
    </EditorStateContext.Provider>
  );
}

// ── Hook ───────────────────────────────────────────────────────────────

export function useEditorState(): EditorStateContextValue {
  const ctx = useContext(EditorStateContext);
  if (!ctx) throw new Error("useEditorState must be used within EditorStateProvider");
  return ctx;
}
