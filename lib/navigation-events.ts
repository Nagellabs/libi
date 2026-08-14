import { EventEmitter } from "events";

/**
 * Global event emitter for navigation events from MCP tools to the UI.
 * Used by libi.show_piece and libi.show_asset to navigate the editor.
 * The SSE endpoint subscribes to these events and forwards them to clients.
 *
 * Navigation events broadcast to ALL SSE connections (not scoped per chat window).
 * This is intentional for a single-user desktop app — the editor should respond
 * to navigation regardless of which chat window triggered the tool call.
 */
const globalForNav = globalThis as unknown as { __navEmitter?: EventEmitter };
if (!globalForNav.__navEmitter) {
  globalForNav.__navEmitter = new EventEmitter();
  globalForNav.__navEmitter.setMaxListeners(50);
}
export const navigationEmitter = globalForNav.__navEmitter;

export interface NavigateEvent {
  target: "piece" | "asset" | "preview" | "storyboard" | "folder";
  /** Required for piece/asset/preview/storyboard/folder targets. */
  pieceId?: string;
  fileId?: string;
  /** Optional id for special targets. */
  id?: string;
}

export interface RefreshQueryEvent {
  queryKey: string;
  pieceId?: string;
  /** Optional hint identifying the scene that was just created/updated/deleted.
   *  The client may use it to jump the preview to the first change. */
  sceneId?: string;
  /** Set when queryKey === "analysis": the file whose analysis row changed. */
  fileId?: string;
  /** Set when queryKey === "track": the track whose sidecar changed. */
  trackId?: string;
}

export interface InstructionsUpdatedEvent {
  sessionsTerminated: number;
}

export interface AnalysisChangedEvent {
  fileId: string;
}

export interface OverlayErrorEvent {
  pieceId: string;
  overlayId: string;
  message: string;
}

export interface NavigateSettingsEvent {
  /** Optional MCP id to focus + scroll to. */
  mcpId?: string;
}

export interface RightRegionEvent {
  mode: "editor" | "onboarding" | "api-config";
  /** Set when mode === "api-config": the bundled MCP id to configure. */
  mcpId?: string;
}

/** Guided-edit highlight: flash an inspector field for an overlay (from the
 *  agent's `libi.highlight_property` tool). The preview surface selects the
 *  overlay, bumps complexity mode if the field is gated, and flashes it. */
export interface HighlightEvent {
  pieceId: string;
  overlayId: string;
  /** Inspector field key (e.g. "background.color"); matched against `data-field`. */
  property: string;
  /** Optional short callout note rendered next to the flashed field. */
  note?: string;
}

/** Set a specific overlay's inspector tab/group (from `libi.set_complexity_mode`). */
export interface SetComplexityModeEvent {
  /** Piece the overlay belongs to (mirrors HighlightEvent). */
  pieceId?: string;
  /** Overlay whose inspector tab to switch. */
  overlayId: string;
  /** Intent group (tab) to reveal. */
  mode: "transform" | "style" | "text" | "3d" | "anchors";
}

/** Guided-edit highlight for effects: flash a catalog effect (opening the
 *  effects panel to its family/phase) or an effect already applied to a
 *  layer's slot (from the agent's `libi.highlight_effect` tool). */
export interface HighlightEffectEvent {
  pieceId: string;
  target:
    | { kind: "catalog"; effectId: string; phase?: "in" | "out" | "loop" }
    | { kind: "applied"; layerId: string; phase: "in" | "out" | "loop" };
  note?: string;
}

/**
 * Signal that agent-governing content (custom instructions override or
 * memories) was mutated through the HTTP surface rather than by the agent's
 * own MCP tools. RC-A defense-in-depth: if a same-origin path ever reaches
 * these write routes, the change is auditable (security-tagged log) and the
 * UI can surface a "changed by a non-agent write" banner. Emitted alongside
 * the existing `instructions_updated` reset event.
 */
export interface SecuritySettingsChangedEvent {
  kind: "instructions-override" | "memories";
  /** How the write arrived — currently always an HTTP settings route. */
  via: "http";
  /** True for the override DELETE (revert to bundled template). */
  reverted?: boolean;
}

/** Emit a `security_settings_changed` event on the navigation emitter. */
export function emitSecuritySettingsChanged(
  event: SecuritySettingsChangedEvent,
): void {
  navigationEmitter.emit("security_settings_changed", event);
}

/** Emit a `highlight` event on the navigation emitter. */
export function emitHighlight(event: HighlightEvent): void {
  navigationEmitter.emit("highlight", event);
}

/** Emit a `highlight_effect` event on the navigation emitter. */
export function emitHighlightEffect(event: HighlightEffectEvent): void {
  navigationEmitter.emit("highlight_effect", event);
}

/** Emit a `set_complexity_mode` event on the navigation emitter. */
export function emitSetComplexityMode(event: SetComplexityModeEvent): void {
  navigationEmitter.emit("set_complexity_mode", event);
}
