"use client";

import type { Step, TargetDraft } from "@/components/social/composer/types";
import type { WhenDraft } from "@/components/social/composer/when-step";

/**
 * The composer's work-in-progress, kept on this machine so leaving the
 * Posting tab does not throw it away.
 *
 * A composer draft is NOT provider data and never becomes any: nothing here is
 * sent anywhere, and the moment the post exists at the provider this is
 * cleared, because from then on the provider's own draft is the record. That
 * is why it lives in `localStorage` rather than libi's database — it is a
 * half-typed form on one machine, and the database deliberately holds only the
 * chosen provider, the settings and the piece ↔ post link table.
 *
 * Two things are deliberately NOT restored:
 * - **TikTok's consent boxes.** They are an attestation the user makes about
 *   the post they are about to send. Re-ticking them costs two clicks; having
 *   them arrive pre-ticked from a session days ago does not.
 * - **"Publish now".** A restored draft opens as a draft. Coming back to a
 *   half-finished composer and finding it armed to publish irreversibly is the
 *   one restore that could cost something real.
 */
export interface ComposerDraft {
  v: 1;
  step: Step;
  exportPath: string | null;
  targets: TargetDraft[];
  caption: string;
  when: WhenDraft;
  savedAt: string;
}

/** One key per piece AND per provider draft being edited: editing an existing
 *  draft and composing a new post are different pieces of work. */
export function composerDraftKey(pieceId: string, draftPostId: string | null): string {
  return `libi.social.composer:${pieceId}:${draftPostId ?? "new"}`;
}

/** Drafts older than this are ignored: a form abandoned a fortnight ago is
 *  noise, and its export may not even exist any more. */
const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export function readComposerDraft(key: string, now: number = Date.now()): ComposerDraft | null {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    // Private mode, blocked site data, or no window at all. Autosave is a
    // convenience: losing it must never stop the composer from opening.
    return null;
  }
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as ComposerDraft;
    if (d?.v !== 1 || !Array.isArray(d.targets)) return null;
    if (now - new Date(d.savedAt).getTime() > MAX_AGE_MS) return null;
    // Never restore an armed "publish now" — see the note above.
    return d.when?.mode === "now" ? { ...d, when: { mode: "draft" } } : d;
  } catch {
    return null;
  }
}

export function writeComposerDraft(key: string, draft: Omit<ComposerDraft, "v" | "savedAt">): void {
  try {
    window.localStorage.setItem(key, JSON.stringify({ ...draft, v: 1, savedAt: new Date().toISOString() }));
  } catch {
    // Quota, private mode — the composer keeps working without autosave.
  }
}

export function clearComposerDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to do: the read side treats a missing or unreadable draft the same.
  }
}

/** True when there is anything worth keeping — an untouched composer must not
 *  leave a draft behind, or every piece would look like it has work pending. */
export function draftIsMeaningful(d: Omit<ComposerDraft, "v" | "savedAt">): boolean {
  return d.caption.trim().length > 0 || d.when.mode !== "draft" || d.step !== "media";
}
