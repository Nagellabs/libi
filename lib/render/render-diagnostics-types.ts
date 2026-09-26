/**
 * The shapes and caps of body-layer diagnostics (spec §4.7), shared by the
 * server store (`render-diagnostics-store.ts`), its route, the MCP tool and
 * the preview's client store. Types and constants only: the client imports
 * this, so the server store's Maps and zod stay out of the browser bundle.
 */

export interface RenderDiagnostic {
  overlayId: string;
  kind: "code" | "three" | "tracked";
  phase: "compile" | "build" | "render";
  /** Text the BODY produced (a thrown message, a refused URL) — untrusted. */
  message: string;
  line?: number;
  column?: number;
  /** `render` errors: the composition time (seconds) of the frame that failed,
   *  rounded to ms — what `libi.render_overlay_frames({ atTimes })` takes; a
   *  time within 1 ms of a frame's time renders exactly that frame. */
  time?: number;
  /** `render` errors: the absolute composition frame that failed — the frame
   *  `time` names, stated exactly. `render_overlay_frames` echoes the frame it
   *  drew for each time, so the two can be matched. */
  frame?: number;
  /** Unix ms when the host observed it. */
  at: number;
}

export interface RenderDiagnosticRecord extends RenderDiagnostic {
  /** Absolute path of the overlay's code file — what the agent opens and fixes. */
  file?: string;
}

export interface UnattributedRenderDiagnostic {
  message: string;
  line?: number;
  column?: number;
  /** Unix ms of the LATEST occurrence. */
  at: number;
}

/** What the route accepts per PUT and the store keeps per piece. The client
 *  sends at most this many — compile/build first, then the newest renders. */
export const MAX_DIAGNOSTICS_PER_PIECE = 50;
export const MAX_UNATTRIBUTED_PER_PIECE = 10;
/** Longest `message` the route accepts; a sender truncates to it rather than
 *  have the whole entry refused. */
export const MAX_DIAGNOSTIC_MESSAGE_CHARS = 4000;
/** How long an unattributed diagnostic stays readable after it last occurred. */
export const UNATTRIBUTED_TTL_MS = 5 * 60_000;

/** An export's (or `libi.render_overlay_frames`') failure record: which body
 *  failed, by the hash of the source the render page loaded. The server keeps
 *  it only while that is still the overlay's current draft body. */
export interface ExportRenderDiagnostic extends RenderDiagnostic {
  sourceHash?: string;
}

/** The composition frames one overlay's body rendered WITHOUT an error in an
 *  export pass, as half-open `[start, end)` ranges, and the source it ran. */
export interface CleanLayerFrames {
  overlayId: string;
  sourceHash: string;
  frames: Array<[number, number]>;
}

/** What the render page posts back as the `renderDiagnostics` form field. */
export interface ExportDiagnosticsReport {
  /** The composition fps the `frames` ranges count in. */
  fps: number;
  diagnostics: ExportRenderDiagnostic[];
  unattributed: UnattributedRenderDiagnostic[];
  clean: CleanLayerFrames[];
}
