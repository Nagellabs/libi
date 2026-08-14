// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { OverlayHandles } from "@/components/preview/overlay-handles";
import { OverlayEditStoreProvider } from "@/lib/preview/overlay-edit-context";
import type { OverlayEditStore } from "@/lib/preview/overlay-edit-store";
import type { Composition, TextOverlay } from "@/lib/engine/types";

const composition = {
  width: 1920,
  height: 1080,
  fps: 30,
  durationInFrames: 60,
  scenes: [],
  overlays: [],
} as unknown as Composition;

const overlay: TextOverlay = {
  id: "ov1",
  kind: "text",
  content: "TILT TEST",
  font: "100px Inter",
  color: "#fff",
  align: "center",
  fontSize: 100,
  opacity: 1,
  rect: { x: 760, y: 500, width: 400, height: 120 },
  anchor: "mid-center",
  position: { x: 960, y: 540 },
  startTime: 0,
  duration: 2,
  z: 1,
};

/** Spy edit store: records every `preview`/`commit`/`cancelPreview` call so a
 *  gesture's preview-then-commit handoff can be asserted. */
function makeEditStore(): OverlayEditStore & {
  preview: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  confirm: ReturnType<typeof vi.fn>;
  cancelPreview: ReturnType<typeof vi.fn>;
} {
  return {
    getAll: vi.fn(() => new Map()),
    getCommitted: vi.fn(() => new Map()),
    preview: vi.fn(),
    commit: vi.fn(() => 1),
    confirm: vi.fn(),
    cancelPreview: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeImperative: vi.fn(() => () => {}),
  } as unknown as OverlayEditStore & {
    preview: ReturnType<typeof vi.fn>;
    commit: ReturnType<typeof vi.fn>;
    confirm: ReturnType<typeof vi.fn>;
    cancelPreview: ReturnType<typeof vi.fn>;
  };
}

function renderHandles(extra: Partial<React.ComponentProps<typeof OverlayHandles>> = {}) {
  const onRequestEdit = vi.fn();
  const onCommit = vi.fn();
  const editStore = makeEditStore();
  const utils = render(
    <OverlayEditStoreProvider value={editStore}>
      <OverlayHandles
        composition={composition}
        overlay={overlay}
        canvasDisplayWidth={480}
        canvasDisplayHeight={270}
        getCanvasBounds={() => new DOMRect(0, 0, 480, 270)}
        snapEnabled
        siblingAnchorsX={[]}
        siblingAnchorsY={[]}
        onRequestEdit={onRequestEdit}
        onCommit={onCommit}
        {...extra}
      />
    </OverlayEditStoreProvider>,
  );
  return { ...utils, onRequestEdit, onCommit, editStore };
}

describe("OverlayHandles — 3D-mode text frames the box on overlay.rect (window model)", () => {
  // canvas 480x270 over a 1920x1080 composition ⇒ uniform 0.25 scale.
  const SCALE = 480 / 1920;
  function renderWith(ov: TextOverlay) {
    const editStore = makeEditStore();
    return render(
      <OverlayEditStoreProvider value={editStore}>
        <OverlayHandles
          composition={composition}
          overlay={ov}
          canvasDisplayWidth={480}
          canvasDisplayHeight={270}
          getCanvasBounds={() => new DOMRect(0, 0, 480, 270)}
          snapEnabled
          siblingAnchorsX={[]}
          siblingAnchorsY={[]}
          onRequestEdit={vi.fn()}
          onCommit={vi.fn()}
        />
      </OverlayEditStoreProvider>,
    );
  }

  it("a place3d text overlay draws its box exactly at overlay.rect with a rect-CENTER pivot", () => {
    const ov: TextOverlay = { ...overlay, place3d: true };
    const { getByTestId } = renderWith(ov);
    const box = getByTestId("overlay-handles");
    // rect {760,500,400,120} * 0.25 = {190,125,100,30}
    expect(box.style.left).toBe(`${760 * SCALE}px`);
    expect(box.style.top).toBe(`${500 * SCALE}px`);
    expect(box.style.width).toBe(`${400 * SCALE}px`);
    expect(box.style.height).toBe(`${120 * SCALE}px`);
    // pivot = box center (matches the renderer's roll about the rect center)
    expect(box.style.transformOrigin).toBe(`${(400 * SCALE) / 2}px ${(120 * SCALE) / 2}px`);
  });

  it("a place3d text reflects transform3d.rotation.z on the box even when 3D-tilted (spatial)", () => {
    const ov: TextOverlay = {
      ...overlay,
      place3d: true,
      // tilt (x/y) ⇒ classifyTransform 'spatial'; z is the in-plane Spin.
      transform3d: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0.6, y: 0.3, z: Math.PI / 2 } },
    };
    const { getByTestId } = renderWith(ov);
    const box = getByTestId("overlay-handles");
    // 90° spin must show on the box (before the fix a spatial overlay read the
    // legacy overlay.rotation = 0 and the box never spun).
    expect(box.style.transform).toContain("rotate(90deg)");
    // tilt/position stay INSIDE the GL viewport ⇒ no 2D box translate.
    expect(box.style.transform).toContain("translate(0px, 0px)");
  });
});

describe("OverlayHandles — double-click body requests inline edit", () => {
  it("calls onRequestEdit when the body surface is double-clicked", () => {
    const { getByTestId, onRequestEdit } = renderHandles();
    fireEvent.doubleClick(getByTestId("overlay-handles-body"));
    expect(onRequestEdit).toHaveBeenCalledTimes(1);
  });

  it("does NOT call onRequestEdit on a single click of the body (that is a move-drag)", () => {
    const { getByTestId, onRequestEdit } = renderHandles();
    fireEvent.mouseDown(getByTestId("overlay-handles-body"));
    fireEvent.mouseUp(getByTestId("overlay-handles-body"));
    expect(onRequestEdit).not.toHaveBeenCalled();
  });
});

describe("OverlayHandles — rotate gesture: preview on move, commit on up (I-1)", () => {
  it("writes the in-plane spin to transform3d via editStore.preview on move (no commit), then commits+flushes on up", () => {
    const onFlush = vi.fn();
    const { getByTestId, onCommit, editStore } = renderHandles({ onFlush });
    const rotate = getByTestId("overlay-handles-rotate");
    fireEvent.mouseDown(rotate, { clientX: 240, clientY: 100 });
    // Drag to a clearly different angle so a non-empty rotation patch is produced.
    fireEvent.mouseMove(window, { clientX: 360, clientY: 240 });

    // The move writes the live rotation to the edit store's PREVIEW channel as a
    // transform3d patch (rotation.z) — the AUTHORITATIVE orientation model, not
    // the legacy `overlay.rotation` (which the renderer ignores when a
    // transform3d exists). It does NOT commit (that's the per-move React
    // recomposite that caused jank).
    const spinPreviews = editStore.preview.mock.calls.filter((c) => {
      const t3d = (c[1] as { transform3d?: { rotation?: { z?: number } } })?.transform3d;
      return t3d?.rotation?.z !== undefined && t3d.rotation.z !== 0;
    });
    expect(spinPreviews.length).toBeGreaterThan(0);
    // Preview targets THIS overlay id.
    expect(editStore.preview.mock.calls[0]![0]).toBe("ov1");
    expect(onCommit).not.toHaveBeenCalled();
    // No preview should ever flip to committed directly here — that's onCommit's job.
    expect(editStore.commit).not.toHaveBeenCalled();

    fireEvent.mouseUp(window);

    // A transform3d (spin) must have been committed via onCommit on up, exactly
    // one flush fired, and the last commit must precede the flush (no deferred-rAF
    // clear, no commit deferred past flush).
    const spinCommits = onCommit.mock.calls.filter((c) => {
      const t3d = (c[0] as { transform3d?: { rotation?: { z?: number } } })?.transform3d;
      return t3d?.rotation?.z !== undefined;
    });
    expect(spinCommits.length).toBeGreaterThan(0);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("ov1");

    const lastCommitOrder =
      onCommit.mock.invocationCallOrder[onCommit.mock.invocationCallOrder.length - 1];
    const flushOrder = onFlush.mock.invocationCallOrder[0];
    expect(lastCommitOrder).toBeLessThan(flushOrder);
  });
});
