"use client";

import { useEffect, useRef, useState } from "react";
import { Sparkles, TriangleAlert, X } from "lucide-react";

import {
  useAnnouncement,
  useMarkAnnouncementsSeen,
  type AnnouncementDto,
} from "@/lib/queries/announcements";
import { trackEvent } from "@/lib/analytics/client";
import { cn } from "@/lib/utils";

/**
 * The top-of-app announcement banner — a full-width strip rendered by
 * AppShell between the titlebar and the app, in normal flow (it pushes the
 * app down and returns the space on dismiss).
 *
 * Behaviour rules (spec: announcements design, 2026-08-12):
 *  - The first announcement the query hands us is LATCHED into local state:
 *    marking it seen invalidates the query, which then returns null, and the
 *    banner must not vanish while the user is reading it.
 *  - Displaying IS seeing. On first render we mark every live id seen (the
 *    shown one and any older ones we dropped — "only the newest" semantics),
 *    so nothing reappears at the next launch. This is deliberately NOT the
 *    update toast's per-launch sessionStorage dismissal — do not unify them.
 *  - X hides immediately; the seen rows are already written by then.
 */
export function AnnouncementBanner({
  onHeightChange,
}: {
  onHeightChange?: (height: number) => void;
} = {}) {
  const { data } = useAnnouncement();
  const markSeen = useMarkAnnouncementsSeen();

  const [latched, setLatched] = useState<AnnouncementDto | null>(null);
  const [liveIds, setLiveIds] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const markedRef = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const onHeightChangeRef = useRef(onHeightChange);
  useEffect(() => {
    onHeightChangeRef.current = onHeightChange;
  });

  // Latch the first announcement the query hands us. This is a render-phase
  // state update (React's documented "adjusting state based on props/query
  // results" pattern), not an effect: the `!latched` guard makes it
  // self-limiting, and doing it here (rather than in a useEffect) avoids an
  // extra commit-then-cascading-render round trip for what is a pure
  // derivation of local state from query data.
  if (!latched && data?.announcement) {
    setLatched(data.announcement);
    setLiveIds(data.liveIds);
  }

  useEffect(() => {
    if (!latched || markedRef.current) return;
    markedRef.current = true;
    // POST /api/announcements/seen rejects bodies over MAX_IDS (50) ids, so cap
    // the list rather than risk a 400 that would leave the banner un-latched and
    // reappearing at every launch once there are >50 live announcements. `latched`
    // is placed first and deduped before the cap so the one actually shown always
    // survives, even though in practice it is also the newest (and thus first) in
    // `liveIds`.
    const idsToMark =
      liveIds.length > 0
        ? [latched.id, ...liveIds.filter((id) => id !== latched.id)].slice(0, 50)
        : [latched.id];
    // Failure is ignored: worst case the announcement shows once more at the
    // next launch. The analytics param is bounded ("feature" | "issue").
    markSeen.mutate(idsToMark);
    trackEvent("announcement_shown", { kind: latched.kind });
  }, [latched, liveIds, markSeen]);

  const visible = !!latched && !dismissed;

  // Report the banner's rendered height to the caller (AppShell forwards it
  // into `--banner-h` for the fixed sidebar) via a ResizeObserver, and 0 the
  // moment it stops being visible — the cleanup below covers both dismiss
  // and unmount, since either flips `visible` to false / tears the effect
  // down. `onHeightChangeRef` keeps the dep array honest: the callback is a
  // fresh function on every parent render, but only `visible` should
  // re-trigger the observer setup.
  useEffect(() => {
    if (!visible) return;
    const element = rootRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      const height = entry?.borderBoxSize?.[0]?.blockSize ?? element.offsetHeight;
      onHeightChangeRef.current?.(height);
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      onHeightChangeRef.current?.(0);
    };
  }, [visible]);

  if (!latched || dismissed) return null;

  const isIssue = latched.kind === "issue";
  const Icon = isIssue ? TriangleAlert : Sparkles;

  return (
    <div
      ref={rootRef}
      role="status"
      className={cn(
        "flex w-full shrink-0 items-center gap-2.5 border-b px-3.5 py-2",
        isIssue ? "border-destructive/35 bg-destructive/10" : "border-primary/35 bg-primary/10",
      )}
    >
      <Icon
        className={cn("size-4 shrink-0", isIssue ? "text-destructive" : "text-primary")}
      />
      <p className="min-w-0 flex-1 text-[13px] leading-snug line-clamp-2">
        <span className="font-medium text-foreground">{latched.title}</span>{" "}
        <span className="text-muted-foreground">{latched.body}</span>
        {latched.url ? (
          <>
            {" "}
            <a
              href={latched.url}
              target="_blank"
              rel="noreferrer"
              className={cn(
                "cursor-pointer underline underline-offset-2",
                isIssue ? "text-destructive" : "text-primary",
              )}
            >
              Learn more
            </a>
          </>
        ) : null}
      </p>
      <button
        type="button"
        aria-label="Dismiss announcement"
        onClick={() => setDismissed(true)}
        className="shrink-0 cursor-pointer text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
