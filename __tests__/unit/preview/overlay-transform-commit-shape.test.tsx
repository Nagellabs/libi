// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { OverlayTransformControls } from "@/components/preview/overlay-transform-controls";
import { OverlayEditStoreProvider } from "@/lib/preview/overlay-edit-context";
import type { OverlayEditStore } from "@/lib/preview/overlay-edit-store";
import { applyResizeDrag } from "@/lib/preview/overlay-drag-math";
import type { Composition, ImageOverlay, Transform3D } from "@/lib/engine/types";

/**
 * Commit-shape invariants for the on-canvas transform gestures (Task 1 of the
 * "single rotation authority" plan): `transform3d.rotation.z` is the ONLY
 * rotation storage. A move/resize commits the rect ONLY (never a rotation or a
 * transform3d); a rotate commits `transform3d` ONLY (never a legacy `rotation`
 * field) — for BOTH transform3d-bearing and plain overlays.
 */

const composition = {
  width: 200,
  height: 200,
  fps: 30,
  durationInFrames: 60,
  overlays: [],
} as unknown as Composition;

function imageOverlay(over: Partial<ImageOverlay> = {}): ImageOverlay {
  return {
    id: "img1",
    kind: "image",
    fileId: "f1",
    rect: { x: 20, y: 20, width: 100, height: 100 },
    startTime: 0,
    duration: 2,
    z: 1,
    opacity: 1,
    ...over,
  } as ImageOverlay;
}

function makeEditStore(): OverlayEditStore & {
  preview: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
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
    cancelPreview: ReturnType<typeof vi.fn>;
  };
}

function renderControls(overlay: ImageOverlay) {
  const onCommit = vi.fn();
  const onFlush = vi.fn();
  const editStore = makeEditStore();
  const utils = render(
    <OverlayEditStoreProvider value={editStore}>
      <OverlayTransformControls
        composition={composition}
        overlay={overlay}
        canvasDisplayWidth={200}
        canvasDisplayHeight={200}
        getCanvasBounds={() => new DOMRect(0, 0, 200, 200)}
        onCommit={onCommit}
        onFlush={onFlush}
      />
    </OverlayEditStoreProvider>,
  );
  return { ...utils, onCommit, onFlush, editStore };
}

/** The single patch object passed to the one onCommit call. */
function committedPatch(onCommit: ReturnType<typeof vi.fn>): Record<string, unknown> {
  expect(onCommit).toHaveBeenCalledTimes(1);
  return onCommit.mock.calls[0]![0] as Record<string, unknown>;
}

describe("OverlayTransformControls — rotation-authority commit shapes", () => {
  it("move on a spun overlay commits rect only — no rotation write, transform3d untouched", () => {
    const t3d: Transform3D = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: Math.PI / 4 },
    };
    const { getByTestId, onCommit } = renderControls(imageOverlay({ transform3d: t3d }));

    fireEvent.mouseDown(getByTestId("overlay-move-body"), { clientX: 50, clientY: 50 });
    fireEvent.mouseMove(window, { clientX: 90, clientY: 50 }); // +40px x
    fireEvent.mouseUp(window);

    const patch = committedPatch(onCommit);
    expect(patch.rect).toBeDefined();
    expect((patch.rect as { x: number }).x).toBeCloseTo(60, 6); // 20 + 40
    expect("rotation" in patch).toBe(false);
    expect("transform3d" in patch).toBe(false);
  });

  it("rotate commits transform3d with the new z (and never a legacy rotation field)", () => {
    const t3d: Transform3D = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    };
    const { getByTestId, onCommit } = renderControls(imageOverlay({ transform3d: t3d }));

    // rect center = (70, 70); a pointer straight to the right ⇒ 90° clockwise.
    fireEvent.mouseDown(getByTestId("overlay-rotate-handle"), { clientX: 70, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 170, clientY: 70 });
    fireEvent.mouseUp(window);

    const patch = committedPatch(onCommit);
    expect("rotation" in patch).toBe(false);
    const committed = patch.transform3d as Transform3D;
    expect(committed).toBeDefined();
    expect(committed.rotation.z).toBeCloseTo(Math.PI / 2, 5);
    expect(committed.rotation.x).toBe(0);
    expect(committed.rotation.y).toBe(0);
  });

  it("rotate on a plain overlay (no transform3d) ALSO commits transform3d (creates it)", () => {
    const { getByTestId, onCommit } = renderControls(imageOverlay()); // no transform3d

    fireEvent.mouseDown(getByTestId("overlay-rotate-handle"), { clientX: 70, clientY: 10 });
    fireEvent.mouseMove(window, { clientX: 170, clientY: 70 });
    fireEvent.mouseUp(window);

    const patch = committedPatch(onCommit);
    expect("rotation" in patch).toBe(false);
    const committed = patch.transform3d as Transform3D;
    expect(committed).toBeDefined();
    expect(committed.rotation.z).toBeCloseTo(Math.PI / 2, 5);
  });

  it("resize on a spun overlay commits rect only and inverse-rotates the delta by the spin", () => {
    const t3d: Transform3D = {
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: Math.PI / 2 }, // 90° spin
    };
    const startRect = { x: 20, y: 20, width: 100, height: 100 };
    const { getByTestId, onCommit } = renderControls(imageOverlay({ transform3d: t3d }));

    // Drag the E handle purely in +Y. Under a 90° spin the resize math must map
    // this display delta into the overlay's rotated local axes → grows WIDTH.
    fireEvent.mouseDown(getByTestId("overlay-handle-e"), { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 100, clientY: 140 }); // +40px y
    fireEvent.mouseUp(window);

    const patch = committedPatch(onCommit);
    expect("rotation" in patch).toBe(false);
    expect("transform3d" in patch).toBe(false);
    const expected = applyResizeDrag(
      startRect,
      "e",
      { dxDisplay: 0, dyDisplay: 40 },
      { scaleX: 1, scaleY: 1 },
      90, // seeded from the spin, NOT the removed legacy rotation field
    );
    expect(patch.rect).toEqual(expected);
    // Sanity: the 90°-rotated result differs from the un-rotated (0°) result,
    // proving the spin actually drove the inverse-rotation.
    const unrotated = applyResizeDrag(
      startRect,
      "e",
      { dxDisplay: 0, dyDisplay: 40 },
      { scaleX: 1, scaleY: 1 },
      0,
    );
    expect(patch.rect).not.toEqual(unrotated);
  });
});
