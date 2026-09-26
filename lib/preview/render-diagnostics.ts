"use client";

/**
 * The preview's record of body-layer failures for one piece (spec §4.7):
 * latest per overlay, PUT to the server debounced so a body that throws at
 * 30 Hz costs one request per window, not thirty. This is what the agent sees
 * through `libi.get_piece_state().renderDiagnostics`.
 *
 * The open preview is the authority for its piece: the PUT replaces the
 * server's set, and a new store syncs once on creation so a reopened editor
 * wipes what an earlier session left behind (bodies that are still broken
 * report again within the same window).
 */
import { useEffect, useMemo, useRef } from "react";
import {
  MAX_DIAGNOSTICS_PER_PIECE,
  MAX_DIAGNOSTIC_MESSAGE_CHARS,
  MAX_UNATTRIBUTED_PER_PIECE,
  UNATTRIBUTED_TTL_MS,
  type RenderDiagnostic,
  type UnattributedRenderDiagnostic,
} from "@/lib/render/render-diagnostics-types";
import type { RenderDiagnosticInput, UnattributedDiagnosticInput } from "@/hooks/preview/use-overlay-layers";
import type { PreviewAssetsOptions } from "@/hooks/editor/use-preview-assets";
import { FRAME_STARTING_MESSAGE } from "@/lib/sandbox/host";

export interface RenderDiagnosticsPayload {
  diagnostics: RenderDiagnostic[];
  unattributed: UnattributedRenderDiagnostic[];
}

export interface RenderDiagnosticsStore {
  report(d: RenderDiagnosticInput): void;
  clear(overlayId: string): void;
  /** A runtime failure no overlay can be blamed for — kept piece-level. */
  reportUnattributed(d: UnattributedDiagnosticInput): void;
  /** Withdraw an unattributed entry that no longer holds (the sandbox's
   *  "still starting" notice once its frame loads, R2-M1). */
  clearUnattributed(message: string): void;
  snapshot(): RenderDiagnostic[];
  /** Every unattributed entry the store holds, oldest first. */
  snapshotUnattributed(): UnattributedRenderDiagnostic[];
  flush(): Promise<void>;
  /** Sends a change still waiting on the debounce, then stops for good. */
  dispose(): void;
}

async function defaultPut(pieceId: string, payload: RenderDiagnosticsPayload): Promise<void> {
  const res = await fetch(`/api/pieces/${encodeURIComponent(pieceId)}/render-diagnostics`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`render-diagnostics PUT failed: ${res.status}`);
}

/** compile/build before render: a body that never loaded draws nothing at
 *  all, while a render error is one frame's story. Then newest first. */
const phaseRank = (d: RenderDiagnostic) => (d.phase === "render" ? 1 : 0);

/** The set the route accepts — at most MAX_DIAGNOSTICS_PER_PIECE. Sending
 *  more had the route refuse EVERY PUT, freezing a stale list on the server
 *  and swallowing every later clear. The store keeps them all, so a cleared
 *  entry frees its slot for the next. */
function capped(diagnostics: Iterable<RenderDiagnostic>): RenderDiagnostic[] {
  const all = Array.from(diagnostics);
  if (all.length <= MAX_DIAGNOSTICS_PER_PIECE) return all;
  return all.sort((a, b) => phaseRank(a) - phaseRank(b) || b.at - a.at).slice(0, MAX_DIAGNOSTICS_PER_PIECE);
}

function positioned<T extends object>(base: T, line?: number, column?: number): T & { line?: number; column?: number } {
  return { ...base, ...(line ? { line } : {}), ...(column ? { column } : {}) };
}

export function createRenderDiagnosticsStore(opts: {
  pieceId: string;
  put?: (pieceId: string, payload: RenderDiagnosticsPayload) => Promise<void>;
  debounceMs?: number;
  now?: () => number;
}): RenderDiagnosticsStore {
  const put = opts.put ?? defaultPut;
  const debounceMs = opts.debounceMs ?? 300;
  const now = opts.now ?? (() => Date.now());
  const byOverlay = new Map<string, RenderDiagnostic>();
  const unattributed = new Map<string, UnattributedRenderDiagnostic>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const payload = (): RenderDiagnosticsPayload => {
    const t = now();
    for (const [key, d] of unattributed) if (t - d.at > UNATTRIBUTED_TTL_MS) unattributed.delete(key);
    return {
      diagnostics: capped(byOverlay.values()),
      unattributed: Array.from(unattributed.values())
        .sort((a, b) => a.at - b.at)
        .slice(-MAX_UNATTRIBUTED_PER_PIECE),
    };
  };
  const send = async () => {
    try {
      await put(opts.pieceId, payload());
    } catch {
      // The badge still shows it; the next change retries the PUT.
    }
  };
  const flush = async () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (disposed) return;
    await send();
  };
  const schedule = () => {
    if (disposed) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void flush();
    }, debounceMs);
  };

  // First sync: replace whatever an earlier session left on the server.
  schedule();

  return {
    report(d) {
      byOverlay.set(d.overlayId, {
        ...positioned(
          { overlayId: d.overlayId, kind: d.kind, phase: d.phase, message: d.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS) },
          d.line,
          d.column,
        ),
        ...(d.time !== undefined ? { time: d.time } : {}),
        ...(d.frame !== undefined ? { frame: d.frame } : {}),
        at: now(),
      });
      schedule();
    },
    clear(overlayId) {
      if (!byOverlay.delete(overlayId)) return;
      schedule();
    },
    reportUnattributed(d) {
      // Bounded at insert, in count and in size (final security review, I1):
      // the TTL prune ran only when a payload was built, so a burst of unique
      // reports grew this map — and its JSON keys, a second copy of each
      // message — without limit until then. Only the newest
      // MAX_UNATTRIBUTED_PER_PIECE are ever sent, so nothing older is kept.
      const message = d.message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS);
      const key = JSON.stringify([message, d.line ?? null, d.column ?? null]);
      // Re-inserted so the map's order is also newest-last.
      unattributed.delete(key);
      unattributed.set(key, { ...positioned({ message }, d.line, d.column), at: now() });
      while (unattributed.size > MAX_UNATTRIBUTED_PER_PIECE) {
        const oldest = unattributed.keys().next().value;
        if (oldest === undefined) break;
        unattributed.delete(oldest);
      }
      schedule();
    },
    clearUnattributed(message) {
      const key = JSON.stringify([message.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS), null, null]);
      if (!unattributed.delete(key)) return;
      schedule();
    },
    snapshot: () => Array.from(byOverlay.values()),
    snapshotUnattributed: () => Array.from(unattributed.values()),
    flush,
    dispose() {
      if (disposed) return;
      const pending = timer !== null;
      if (timer) clearTimeout(timer);
      timer = null;
      if (pending) void send();
      disposed = true;
    },
  };
}

/**
 * The preview's store for the piece open NOW, as the three callbacks
 * `usePreviewAssets` takes, plus `diagnosticsKey` (the piece) so the overlay
 * layers re-announce what is still failing when the piece changes under the
 * same sandbox. No piece (`""`) means no store: nothing to file under.
 *
 * Created in an effect, not a memo: StrictMode's mount→unmount→mount would
 * otherwise leave the one memoized store disposed for good.
 */
export function useRenderDiagnostics(pieceId: string): PreviewAssetsOptions {
  const ref = useRef<RenderDiagnosticsStore | null>(null);
  useEffect(() => {
    if (!pieceId) return;
    const store = createRenderDiagnosticsStore({ pieceId });
    ref.current = store;
    return () => {
      // The sandbox's "still starting" notice is live state, not an event: it
      // holds only while THIS preview shows THIS piece. Its own withdrawal
      // (`onFrameStarting(null)`) cannot be relied on to reach this store —
      // on unmount React disposes this store before `useOverlayLayers`
      // destroys the sandbox, and on a piece switch the withdrawal goes to the
      // next piece's store — so the server kept it for the 5 min unattributed
      // TTL (sandbox re-review 3, R3-M4). Withdraw it here, where the PUT
      // `dispose` sends still carries the change. A new piece is told again by
      // the overlay layers' `diagnosticsKey` effect if the frame is still
      // loading.
      store.clearUnattributed(FRAME_STARTING_MESSAGE);
      store.dispose();
      if (ref.current === store) ref.current = null;
    };
  }, [pieceId]);
  return useMemo<PreviewAssetsOptions>(
    () => ({
      onDiagnostic: (d) => ref.current?.report(d),
      onDiagnosticCleared: (overlayId) => ref.current?.clear(overlayId),
      onUnattributed: (d) => ref.current?.reportUnattributed(d),
      onUnattributedCleared: (message) => ref.current?.clearUnattributed(message),
      diagnosticsKey: pieceId,
    }),
    [pieceId],
  );
}
