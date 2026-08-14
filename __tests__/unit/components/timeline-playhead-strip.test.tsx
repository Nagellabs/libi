// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { createRef } from "react";
import { TimelinePlayheadStrip } from "@/components/preview/timeline-playhead-strip";

// jsdom's PointerEvent path doesn't implement pointer capture — the hook
// optional-chains these, but stub them so per-element access never throws.
// rAF is stubbed to a manual queue so the scrub-coalescing tests can flush
// animation frames deterministically.
let rafQueue: FrameRequestCallback[] = [];
function flushRaf() {
  const q = rafQueue;
  rafQueue = [];
  for (const cb of q) cb(performance.now());
}
beforeEach(() => {
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  rafQueue = [];
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    rafQueue[id - 1] = () => {};
  });
});

/** Give the (jsdom zero-sized) lane a real 1000px-wide rect so clientX maps
 *  to distinct frames: with totalFrames=100, frame = round(x/1000*99). */
function giveLaneRect() {
  const lane = screen.getByTestId("playhead-strip");
  lane.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 1000, bottom: 14, width: 1000, height: 14, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return lane;
}

function renderStrip(over: Partial<Parameters<typeof TimelinePlayheadStrip>[0]> = {}) {
  const laneRef = createRef<HTMLDivElement>();
  const props = {
    totalFrames: 100,
    playheadPercent: 50,
    markers: [] as { id: string; time: number }[],
    fps: 30,
    currentFrame: 50,
    onScrub: vi.fn(),
    onMarkerClick: vi.fn(),
    contentWidth: 1000,
    laneRef,
    dragging: false,
    onDraggingChange: vi.fn(),
    ...over,
  };
  render(<TimelinePlayheadStrip {...props} />);
  return props;
}

describe("TimelinePlayheadStrip", () => {
  it("seeks on lane pointerdown and reports drag start/end", () => {
    const props = renderStrip();
    const lane = screen.getByTestId("playhead-strip");
    // jsdom rects are 0-width → frameFromClientX degenerates to frame 0.
    fireEvent.pointerDown(lane, { clientX: 0, pointerId: 1 });
    expect(props.onScrub).toHaveBeenCalledWith(0);
    expect(props.onDraggingChange).toHaveBeenCalledWith(true);
    fireEvent.pointerUp(lane, { pointerId: 1 });
    expect(props.onDraggingChange).toHaveBeenLastCalledWith(false);
  });

  it("does not scrub on pointermove without a prior pointerdown", () => {
    const props = renderStrip();
    fireEvent.pointerMove(screen.getByTestId("playhead-strip"), { clientX: 10, pointerId: 1 });
    expect(props.onScrub).not.toHaveBeenCalled();
  });

  it("renders the pin at the playhead and no ruler lane box", () => {
    renderStrip();
    expect(screen.getByTestId("playhead-pin")).toBeInTheDocument();
    expect(screen.queryByTestId("ruler-lane")).toBeNull();
    // The strip row is sticky so it stays visible while scrolling tracks.
    expect(screen.getByTestId("playhead-strip-row").className).toContain("sticky");
  });

  it("marker click fires onMarkerClick without scrubbing", () => {
    const props = renderStrip({ markers: [{ id: "m1", time: 1 }] });
    const marker = screen.getByTestId("playhead-marker-m1");
    fireEvent.pointerDown(marker, { clientX: 5, pointerId: 1 });
    fireEvent.click(marker);
    expect(props.onMarkerClick).toHaveBeenCalledWith(1);
    expect(props.onScrub).not.toHaveBeenCalled();
  });

  it("shows the timecode chip only while dragging", () => {
    renderStrip({ dragging: true, currentFrame: 45 });
    expect(screen.getByTestId("playhead-timecode-chip")).toBeInTheDocument();
  });

  it("hides the timecode chip when not dragging", () => {
    renderStrip({ dragging: false });
    expect(screen.queryByTestId("playhead-timecode-chip")).toBeNull();
  });

  // Live-QA finding (2026-07-04): hovering the playhead line moved it without
  // a click. Root cause: the drag latch survives a lost pointerup (release
  // outside the window / failed capture / synthetic events), so a bare hover
  // scrubbed. The hook must require a held button to follow, and self-heal a
  // stuck latch on the first buttons-free move.
  describe("drag latch hardening", () => {
    it("drag move with the button held scrubs continuously (per animation frame)", () => {
      const props = renderStrip();
      const lane = giveLaneRect();
      fireEvent.pointerDown(lane, { clientX: 0, pointerId: 1, buttons: 1 });
      fireEvent.pointerMove(lane, { clientX: 400, pointerId: 1, buttons: 1 });
      flushRaf();
      expect(props.onScrub).toHaveBeenCalledTimes(2);
      expect(props.onScrub).toHaveBeenLastCalledWith(40);
    });

    it("a buttons-free hover after a lost pointerup does not scrub and self-heals", () => {
      const props = renderStrip();
      const lane = screen.getByTestId("playhead-strip");
      fireEvent.pointerDown(lane, { clientX: 0, pointerId: 1, buttons: 1 });
      expect(props.onScrub).toHaveBeenCalledTimes(1);
      // No pointerup ever delivered; a plain hover must NOT move the playhead…
      fireEvent.pointerMove(lane, { clientX: 60, pointerId: 1, buttons: 0 });
      expect(props.onScrub).toHaveBeenCalledTimes(1);
      // …and must clear the stuck drag flag (chip hides, select-none lifts).
      expect(props.onDraggingChange).toHaveBeenLastCalledWith(false);
    });

    it("non-primary-button pointerdown neither scrubs nor starts a drag", () => {
      const props = renderStrip();
      const lane = screen.getByTestId("playhead-strip");
      fireEvent.pointerDown(lane, { clientX: 0, pointerId: 1, button: 2, buttons: 2 });
      expect(props.onScrub).not.toHaveBeenCalled();
      expect(props.onDraggingChange).not.toHaveBeenCalled();
    });
  });

  // Live-QA finding (2026-07-04, round 2 — user): dragging on a video-heavy
  // piece froze the playhead for ~350ms at a time. Root cause: every
  // pointermove issued a hard seek (decoder flush + re-decode) and the
  // backlog replayed serially. Moves are now coalesced to ONE seek per
  // animation frame (latest position wins) and deduped by target frame.
  describe("scrub coalescing", () => {
    it("a burst of moves inside one frame issues one seek at the LATEST position", () => {
      const props = renderStrip();
      const lane = giveLaneRect();
      fireEvent.pointerDown(lane, { clientX: 0, pointerId: 1, buttons: 1 });
      expect(props.onScrub).toHaveBeenCalledTimes(1); // immediate seek on press
      fireEvent.pointerMove(lane, { clientX: 100, pointerId: 1, buttons: 1 });
      fireEvent.pointerMove(lane, { clientX: 200, pointerId: 1, buttons: 1 });
      fireEvent.pointerMove(lane, { clientX: 300, pointerId: 1, buttons: 1 });
      expect(props.onScrub).toHaveBeenCalledTimes(1); // nothing until the frame fires
      flushRaf();
      expect(props.onScrub).toHaveBeenCalledTimes(2); // one coalesced seek…
      expect(props.onScrub).toHaveBeenLastCalledWith(30); // …at the latest x
    });

    it("skips a seek when the target frame is unchanged (dedup)", () => {
      const props = renderStrip();
      const lane = giveLaneRect();
      fireEvent.pointerDown(lane, { clientX: 300, pointerId: 1, buttons: 1 }); // frame 30
      // 302px still rounds to frame 30 — no second seek.
      fireEvent.pointerMove(lane, { clientX: 302, pointerId: 1, buttons: 1 });
      flushRaf();
      expect(props.onScrub).toHaveBeenCalledTimes(1);
    });

    it("pointerup flushes the pending move so release lands exactly", () => {
      const props = renderStrip();
      const lane = giveLaneRect();
      fireEvent.pointerDown(lane, { clientX: 0, pointerId: 1, buttons: 1 });
      fireEvent.pointerMove(lane, { clientX: 500, pointerId: 1, buttons: 1 });
      // No rAF flush — the release itself must land the final position.
      fireEvent.pointerUp(lane, { pointerId: 1 });
      expect(props.onScrub).toHaveBeenLastCalledWith(50);
      expect(props.onDraggingChange).toHaveBeenLastCalledWith(false);
    });
  });
});
