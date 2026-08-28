// @vitest-environment jsdom
import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import {
  useScrollToBottom,
  type TranscriptSize,
} from "@/hooks/use-scroll-to-bottom";

/**
 * First tests for `useScrollToBottom`.
 *
 * The hook is keyed on the chat's session id, and a session switch is the
 * whole problem: `useAgentChat` clears its messages in an EFFECT, so there is
 * one commit where the session prop is already B while B's transcript has not
 * replaced A's in the DOM yet. Two things used to go wrong across that commit:
 *
 *   1. `restoreSavedPosition` changed identity with the key, which re-ran the
 *      chat panel's one-shot restore effect against A's still-mounted DOM —
 *      burning the one shot, so B never got restored at all.
 *   2. Emptying the container makes the browser clamp `scrollTop` toward 0,
 *      and the handler's debounced write saved that clamp under B's key,
 *      corrupting B's remembered position for the next visit.
 *
 * jsdom performs no layout, so every metric the hook reads — `scrollHeight`,
 * `clientHeight`, `scrollTop`, `scrollTo` — has to be supplied by the harness.
 */

const key = (sessionId: string) => `libi:chat-scroll:${sessionId}`;

const size = (count: number, tail: number, progress = 0): TranscriptSize => ({
  count,
  tail,
  progress,
});

/** What the hook wrote, in whichever of the two shapes it chose. */
function saved(sessionId: string): { top: number; size?: TranscriptSize } | null {
  const raw = localStorage.getItem(key(sessionId));
  if (raw === null) return null;
  return raw.startsWith("{") ? JSON.parse(raw) : { top: Number(raw) };
}

/** A position written by a release that remembered the offset and nothing
 *  else — a bare number. Every existing user has these. */
function writeLegacy(sessionId: string, top: number) {
  localStorage.setItem(key(sessionId), String(top));
}

function writeSaved(sessionId: string, top: number, transcript: TranscriptSize) {
  localStorage.setItem(key(sessionId), JSON.stringify({ top, size: transcript }));
}

type Api = ReturnType<typeof useScrollToBottom>;

function setup(initialSessionId?: string, initialSize?: TranscriptSize) {
  // A mutable box rather than a bare `let`: the harness has to hand the live
  // hook return value back out to the test, and assigning an outer variable
  // from inside a component body is a lint error.
  const box: { api: Api | null } = { api: null };
  const metrics = { scrollHeight: 5000, clientHeight: 400, scrollTop: 0 };

  function Harness({
    sessionId,
    transcript,
  }: { sessionId?: string; transcript?: TranscriptSize }) {
    const { containerRef, isAtBottom, scrollToBottom, restoreSavedPosition } =
      useScrollToBottom(sessionId, transcript);
    // Published from an effect, not the render body — writing to something
    // defined outside the component during render is a lint error.
    React.useEffect(() => {
      box.api = { containerRef, isAtBottom, scrollToBottom, restoreSavedPosition };
    });
    return <div data-testid="scroller" ref={containerRef} />;
  }

  const view = render(<Harness sessionId={initialSessionId} transcript={initialSize} />);
  const el = view.getByTestId("scroller");

  Object.defineProperty(el, "scrollHeight", {
    configurable: true,
    get: () => metrics.scrollHeight,
  });
  Object.defineProperty(el, "clientHeight", {
    configurable: true,
    get: () => metrics.clientHeight,
  });
  Object.defineProperty(el, "scrollTop", {
    configurable: true,
    get: () => metrics.scrollTop,
    set: (next: number) => {
      metrics.scrollTop = next;
    },
  });
  el.scrollTo = ((opts: ScrollToOptions | number) => {
    metrics.scrollTop = typeof opts === "number" ? opts : (opts?.top ?? 0);
  }) as HTMLElement["scrollTo"];

  return {
    metrics,
    get api(): Api {
      if (!box.api) throw new Error("harness never rendered");
      return box.api;
    },
    rerender(sessionId?: string, transcript?: TranscriptSize) {
      act(() => {
        view.rerender(<Harness sessionId={sessionId} transcript={transcript} />);
      });
    },
    /** A real user scroll: the browser moves scrollTop, then fires the event. */
    userScrollTo(top: number) {
      metrics.scrollTop = top;
      fireEvent.scroll(el);
    },
  };
}

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useScrollToBottom — session switches", () => {
  it("keeps restoreSavedPosition's identity stable across a session change", () => {
    // The chat panel puts this callback in the dependency array of its
    // one-shot restore effect. If the identity moves when the key moves, that
    // effect fires on the commit where the OLD session's messages are still
    // rendered — which is exactly how the restore got spent on the wrong DOM.
    const h = setup("A");
    const restore = h.api.restoreSavedPosition;
    const toBottom = h.api.scrollToBottom;

    h.rerender("B");

    expect(h.api.restoreSavedPosition).toBe(restore);
    expect(h.api.scrollToBottom).toBe(toBottom);
  });

  it("restores the NEW session's saved offset after a switch, not the old one", () => {
    localStorage.setItem(key("A"), "1200");
    localStorage.setItem(key("B"), "3400");

    const h = setup("A");
    act(() => h.api.restoreSavedPosition());
    expect(h.metrics.scrollTop).toBe(1200);

    h.rerender("B");
    act(() => h.api.restoreSavedPosition());
    expect(h.metrics.scrollTop).toBe(3400);
  });

  it("does not persist scrollTop before the current session has been restored", () => {
    // The clamp-to-zero the empty interim produces looks exactly like a user
    // scrolling to the very top. Saving it would tell the next visit to open
    // B at the top of a transcript the user had left at the bottom.
    const h = setup("B");

    h.userScrollTo(0);
    act(() => vi.advanceTimersByTime(400));

    expect(localStorage.getItem(key("B"))).toBeNull();
  });

  it("persists again once the restore for that session has happened", () => {
    localStorage.setItem(key("B"), "3400");
    const h = setup("B");

    act(() => h.api.restoreSavedPosition());
    h.userScrollTo(900);
    act(() => vi.advanceTimersByTime(400));

    expect(localStorage.getItem(key("B"))).toBe("900");
  });

  it("survives rapid back-and-forth without leaking one session's offset into another", () => {
    localStorage.setItem(key("A"), "1200");
    const h = setup("A");
    act(() => h.api.restoreSavedPosition());

    // A real scroll in A, then a switch before the 300ms debounce fires. The
    // listener teardown drops the pending write — that is what stops A's
    // offset landing under B's key.
    h.userScrollTo(2500);
    h.rerender("B");
    act(() => vi.advanceTimersByTime(400));

    expect(localStorage.getItem(key("B"))).toBeNull();
    expect(localStorage.getItem(key("A"))).toBe("1200");

    // Straight back to A. The restore gate has to RESET with the key, or the
    // second visit's own empty interim writes over A's remembered position.
    h.rerender("A");
    h.userScrollTo(0);
    act(() => vi.advanceTimersByTime(400));

    expect(localStorage.getItem(key("A"))).toBe("1200");
  });

  it("opens a session with no remembered position at its newest message", () => {
    // Without this the container keeps whatever scrollTop the outgoing
    // session left behind: the user lands part-way up a transcript they have
    // never seen, and `isAtBottom` is still the previous session's answer, so
    // the pill is stranded on screen too.
    const h = setup("A");

    h.userScrollTo(100);
    expect(h.api.isAtBottom).toBe(false);

    act(() => h.api.restoreSavedPosition());

    expect(h.metrics.scrollTop).toBe(5000);
    expect(h.api.isAtBottom).toBe(true);
  });

  it("reports not-at-bottom when the saved offset is well above the fold", () => {
    localStorage.setItem(key("A"), "1000");
    const h = setup("A");

    act(() => h.api.restoreSavedPosition());

    expect(h.metrics.scrollTop).toBe(1000);
    expect(h.api.isAtBottom).toBe(false);
  });
});

/**
 * Coming back to a session.
 *
 * The offset alone cannot answer "should I put you back where you were?" —
 * that is only the right answer if the transcript is still the one the offset
 * was measured in. So the size travels with it, and a return compares.
 */
describe("useScrollToBottom — returning to a session", () => {
  it("lands on the newest message when the agent added messages while the user was away", () => {
    writeSaved("A", 1200, size(2, 40));
    const h = setup("A", size(4, 40));

    act(() => h.api.restoreSavedPosition());

    expect(h.metrics.scrollTop).toBe(5000);
    expect(h.api.isAtBottom).toBe(true);
  });

  it("lands on the newest message when the turn they left is still growing", () => {
    // Mid-answer is the COMMON shape of "the agent has been working": no new
    // message, the last one just got longer. A count-only comparison would
    // call this unchanged and drop the user above the new text.
    writeSaved("A", 1200, size(3, 40));
    const h = setup("A", size(3, 900));

    act(() => h.api.restoreSavedPosition());

    expect(h.metrics.scrollTop).toBe(5000);
  });

  it("lands on the newest message when only a tool call reported progress", () => {
    writeSaved("A", 1200, size(3, 40, 111));
    const h = setup("A", size(3, 40, 222));

    act(() => h.api.restoreSavedPosition());

    expect(h.metrics.scrollTop).toBe(5000);
  });

  it("puts the user back where they were when nothing happened while they were away", () => {
    writeSaved("A", 1200, size(3, 40));
    const h = setup("A", size(3, 40));

    act(() => h.api.restoreSavedPosition());

    expect(h.metrics.scrollTop).toBe(1200);
    expect(h.api.isAtBottom).toBe(false);
  });

  it("still restores a position saved before sizes were stored", () => {
    // The upgrade path: a bare number carries no transcript to compare
    // against, so it restores exactly as it did before — never crashes, never
    // silently discards the user's position.
    writeLegacy("A", 1200);
    const h = setup("A", size(9, 900));

    act(() => h.api.restoreSavedPosition());

    expect(h.metrics.scrollTop).toBe(1200);
  });

  it("opens at the newest message when the stored value is unreadable", () => {
    localStorage.setItem(key("A"), "{not json");
    const h = setup("A", size(3, 40));

    act(() => h.api.restoreSavedPosition());

    expect(h.metrics.scrollTop).toBe(5000);
  });

  it("saves the transcript size next to the offset, so the next return can compare", () => {
    writeSaved("A", 1200, size(3, 40));
    const h = setup("A", size(3, 40));

    act(() => h.api.restoreSavedPosition());
    h.userScrollTo(900);
    act(() => vi.advanceTimersByTime(400));

    expect(saved("A")).toEqual({ top: 900, size: size(3, 40) });
  });

  it("does not treat growth the user sat through as growth they missed", () => {
    // The pill's scenario: they scroll up, the answer keeps coming, they read
    // on. Flicking to another session and back must not now yank them to the
    // bottom of text they were deliberately reading above.
    writeSaved("A", 1200, size(3, 40));
    const h = setup("A", size(3, 40));
    act(() => h.api.restoreSavedPosition());
    expect(h.metrics.scrollTop).toBe(1200);

    // The agent streams on while A is the session on screen.
    h.rerender("A", size(4, 80));
    act(() => vi.advanceTimersByTime(400));

    // Away, and back.
    h.rerender("B");
    h.rerender("A", size(4, 80));
    act(() => h.api.restoreSavedPosition());

    expect(h.metrics.scrollTop).toBe(1200);
  });

  it("does not save a watched session's size under another session's key", () => {
    // The size is persisted from an effect of its own; it has to respect the
    // same gate the scroll handler does, or the outgoing session's transcript
    // lands under the incoming key on the commit where they cross over.
    writeSaved("A", 1200, size(3, 40));
    const h = setup("A", size(3, 40));
    act(() => h.api.restoreSavedPosition());

    // The commit where the key is already B while A's transcript is still
    // mounted — exactly what a session switch renders.
    h.rerender("B", size(3, 40));
    act(() => vi.advanceTimersByTime(400));

    expect(saved("B")).toBeNull();
  });
});
