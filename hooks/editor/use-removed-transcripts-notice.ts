"use client";

import { useEffect } from "react";
import { toast } from "sonner";

export interface RemovedTranscriptNotice {
  fileId: string;
  name: string;
}

export function removedTranscriptsNoticeText(removed: readonly RemovedTranscriptNotice[]): string {
  const names = removed.map((r) => `"${r.name}"`);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  const one = removed.length === 1;
  return (
    `The transcript${one ? "" : "s"} of ${list} ${one ? "was" : "were"} removed: an older libi misread ` +
    `${one ? "this file's" : "these files'"} audio, so ${one ? "its" : "their"} timings were wrong. ` +
    `Ask the agent to transcribe ${one ? "it" : "them"} again. Captions already on the timeline are unchanged.`
  );
}

/** Files told during this page's life — covers a refetch before the server's answer drops them. */
const toldThisPage = new Set<string>();

/** Test hook: forget what this page has told. */
export function resetRemovedTranscriptsNoticeForTests(): void {
  toldThisPage.clear();
}

/**
 * Tell the user, once, that a boot migration removed transcripts of this
 * piece's (or the library's) files: the transcript re-time drops a FLAC-in-MP4
 * cut's transcript, whose old decode was garbled (review round 5, M7), and an
 * agent that expected it would otherwise find none with nothing saying why.
 *
 * `removed` is `removedTranscripts` from GET /api/pieces/:id/composition. What
 * is still to be told lives on the SERVER (lib/analysis/removed-transcripts.ts)
 * and is forgotten by the POST sent once the toast is shown, as the legacy
 * canvas-scene notice does (use-legacy-scenes-notice.ts).
 */
export function useRemovedTranscriptsNotice(
  pieceId: string | null,
  removed: readonly RemovedTranscriptNotice[] | undefined,
): void {
  const key = (removed ?? []).map((r) => r.fileId).join(",");
  useEffect(() => {
    if (!pieceId || !removed || removed.length === 0) return;
    const fresh = removed.filter((r) => !toldThisPage.has(r.fileId));
    if (fresh.length === 0) return;
    for (const r of fresh) toldThisPage.add(r.fileId);
    toast.warning(removedTranscriptsNoticeText(fresh), { id: `removed-transcripts-${pieceId}` });
    void fetch(`/api/pieces/${pieceId}/composition/removed-transcripts-notice`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds: fresh.map((r) => r.fileId) }),
    }).catch(() => {
      // Not recorded: the notice may show once more on a later launch. Harmless.
    });
    // `key` stands for `removed`'s content; a new array with the same files changes nothing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pieceId, key]);
}
