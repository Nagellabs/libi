"use client";

import { useEffect, useRef, useState } from "react";

/**
 * A hand-off from somewhere else in the UI (the agent's `libi.show({ target: "piece" })`-style
 * navigate with `target: "posting"`, the Social page's links) into the
 * editor's Posting tab. This is UI-LOCAL state — nothing here persists or
 * leaves the page, and it never substitutes for the server's own notion of a
 * post (see `lib/queries/social.ts`). `nonce` lets the same `pieceId` +
 * `providerPostId` pair be re-delivered and still be treated as a fresh intent
 * by a listener that only reacts to change.
 */
export interface PostingIntent {
  pieceId: string;
  providerPostId?: string | null;
  /** Not "post this" but "show me this one": the Social page's "Piece" link.
   *  The Posting tab opens on its list, narrowed to this post (or ad) id. */
  focusPostId?: string | null;
  /** Start the composer on this export (an export's absolute file path): the
   *  Exports tab's and the resources panel's "Post…". */
  exportPath?: string | null;
  /** The composer sent the user to the export dialog and this is the export
   *  that Start queued: the composer waits for it on its Media step and picks
   *  it when it finishes. */
  awaitExportId?: string | null;
  nonce: number;
}

type Listener = (intent: PostingIntent | null) => void;

const g = globalThis as unknown as {
  __libiPostingIntent?: { current: PostingIntent | null; listeners: Set<Listener>; nonce: number };
};
const store = (g.__libiPostingIntent ??= { current: null, listeners: new Set(), nonce: 0 });

/** Open the Posting tab for a piece, optionally putting the composer into edit
 *  mode for an existing draft or focusing one post. */
export function openPostingTab(intent: Omit<PostingIntent, "nonce">): void {
  store.current = { ...intent, nonce: ++store.nonce };
  for (const listener of store.listeners) listener(store.current);
}

/** Clear the current intent once the Posting tab has acted on it, so a later
 *  remount of the tab doesn't replay a stale hand-off. */
export function consumePostingIntent(): void {
  store.current = null;
}

/**
 * Raw subscription to every `openPostingTab` call, regardless of piece — for
 * the ONE place (the editor page) that has to react by SWITCHING to that
 * piece and the Posting tab, which `usePostingIntent(pieceId)` can't do on
 * its own (it only reads intents for a piece already known to be active).
 * Called inside a listener callback, never synchronously in an effect body,
 * so a caller's `setState` here is the sanctioned "react to an external
 * event" pattern, not a banned setState-in-effect.
 */
export function subscribePostingIntent(listener: (intent: PostingIntent) => void): () => void {
  const wrapped: Listener = (next) => {
    if (next) listener(next);
  };
  store.listeners.add(wrapped);
  return () => {
    store.listeners.delete(wrapped);
  };
}

/** The latest intent for this piece — `null` once consumed, or if the latest
 *  intent targets a different piece. */
export function usePostingIntent(pieceId: string): PostingIntent | null {
  const [intent, setIntent] = useState<PostingIntent | null>(
    store.current?.pieceId === pieceId ? store.current : null,
  );
  // A pieceId change while mounted (unlikely — callers key by pieceId, but
  // cheap to be correct) re-syncs from the store DURING RENDER rather than
  // via a setState-in-effect (which the lint rule bans — cascading renders —
  // and which would show one stale frame first anyway). Same previous-value
  // pattern as `export-dialog.tsx`'s `prevPieceName`/`prevDefaults` blocks.
  const [prevPieceId, setPrevPieceId] = useState(pieceId);
  if (pieceId !== prevPieceId) {
    setPrevPieceId(pieceId);
    setIntent(store.current?.pieceId === pieceId ? store.current : null);
  }
  useEffect(() => {
    const listener: Listener = (next) => setIntent(next && next.pieceId === pieceId ? next : null);
    store.listeners.add(listener);
    return () => {
      store.listeners.delete(listener);
    };
  }, [pieceId]);
  return intent;
}

// ── Export-dialog request ────────────────────────────────────────────────
//
// The Posting tab's "Export & post" must open the REAL export dialog (the one
// already mounted, uncontrolled, in `components/preview/preview-player.tsx`)
// rather than duplicate its form. This is the same kind of tiny global signal
// as the intent above, kept in this file because both exist to let two
// unrelated parts of the editor hand off to each other without a shared
// ancestor.
//
// The editor's tabs unmount their inactive panel (base-ui `Tabs.Panel`, no
// `keepMounted`) — confirmed live: PreviewPlayer's listener count read 0 from
// the Posting tab and 1 the moment the Timeline tab was selected. A request
// fired while nobody is listening would silently do nothing, so `current`
// PERSISTS the latest pending piece (like the posting intent above) and a
// listener that mounts later — because `requestExportDialog` also asks the
// page to switch to the Timeline tab, see `subscribeExportDialogRequest` —
// checks it immediately instead of only reacting to future calls.

type ExportDialogListener = (pieceId: string) => void;

const ge = globalThis as unknown as {
  __libiExportDialogRequest?: {
    current: string | null;
    purpose: "social" | "personal" | null;
    returnToPost: boolean;
    returnDraftPostId: string | null;
    forPost: Set<string>;
    listeners: Set<ExportDialogListener>;
  };
};
const exportDialogStore = (ge.__libiExportDialogRequest ??= {
  current: null,
  purpose: null,
  returnToPost: false,
  returnDraftPostId: null,
  forPost: new Set(),
  listeners: new Set(),
});

/** Ask the export dialog for this piece to open — including switching the
 *  editor to the Timeline tab (`subscribeExportDialogRequest`, wired once at
 *  the page level) so `useExportDialogRequest` gets a chance to mount and
 *  see this even when nothing was listening at call time. `opts.purpose`
 *  preselects the dialog's "What's this export for?" question (e.g. the
 *  Posting tab's "Export & post" opens it as social) — read once via
 *  `takeExportDialogPurpose`. */
export function requestExportDialog(
  pieceId: string,
  opts: { purpose?: "social" | "personal"; returnToPost?: boolean; draftPostId?: string | null } = {},
): void {
  exportDialogStore.current = pieceId;
  exportDialogStore.purpose = opts.purpose ?? null;
  exportDialogStore.returnToPost = opts.returnToPost ?? false;
  // The draft being edited, so the way back reopens IT and not a new post.
  exportDialogStore.returnDraftPostId = opts.returnToPost ? (opts.draftPostId ?? null) : null;
  for (const listener of exportDialogStore.listeners) listener(pieceId);
}

/** The purpose the last request asked the dialog to open with — read once. */
export function takeExportDialogPurpose(): "social" | "personal" | null {
  const p = exportDialogStore.purpose;
  exportDialogStore.purpose = null;
  return p;
}

/** Whether the last request came from the composer, so Start should take the
 *  user back to the post they were making — read once. */
export function takeExportDialogReturnToPost(): boolean {
  const r = exportDialogStore.returnToPost;
  exportDialogStore.returnToPost = false;
  return r;
}

/** The Zernio draft the composer was editing when it asked for the dialog — read once. */
export function takeExportDialogDraftPostId(): string | null {
  const d = exportDialogStore.returnDraftPostId;
  exportDialogStore.returnDraftPostId = null;
  return d;
}

/** An export the composer asked for: its finish toast offers "Continue post". */
export function markExportForPost(exportId: string): void {
  exportDialogStore.forPost.add(exportId);
}

export function isExportForPost(exportId: string): boolean {
  return exportDialogStore.forPost.has(exportId);
}

/** Raw subscription for the editor page to switch tabs on a request — mirrors
 *  `subscribePostingIntent` below. */
export function subscribeExportDialogRequest(listener: ExportDialogListener): () => void {
  exportDialogStore.listeners.add(listener);
  return () => {
    exportDialogStore.listeners.delete(listener);
  };
}

/** Subscribe to `requestExportDialog` calls for one piece — including a
 *  pending one recorded before this mounted (see above). */
export function useExportDialogRequest(pieceId: string, onRequest: () => void): void {
  // Latest-callback ref, written in a deps-less effect (never during render)
  // so the listener always calls the current `onRequest` without
  // re-subscribing.
  const onRequestRef = useRef(onRequest);
  useEffect(() => {
    onRequestRef.current = onRequest;
  });
  useEffect(() => {
    if (exportDialogStore.current === pieceId) {
      exportDialogStore.current = null;
      onRequestRef.current();
    }
    const listener: ExportDialogListener = (id) => {
      if (id === pieceId) {
        exportDialogStore.current = null;
        onRequestRef.current();
      }
    };
    exportDialogStore.listeners.add(listener);
    return () => {
      exportDialogStore.listeners.delete(listener);
    };
  }, [pieceId]);
}
