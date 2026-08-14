// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ThreeGizmoControls } from "@/components/preview/three-gizmo-controls";
import { OverlayTransformControls } from "@/components/preview/overlay-transform-controls";
import { OverlayEditStoreProvider } from "@/lib/preview/overlay-edit-context";
import { IDENTITY_TRANSFORM3D } from "@/lib/overlays/transform3d";
import type { OverlayEditStore } from "@/lib/preview/overlay-edit-store";
import type {
  Composition,
  ImageOverlay,
  Overlay,
  ThreeOverlay,
} from "@/lib/engine/types";

function makeThreeOverlay(over: Partial<ThreeOverlay> = {}): ThreeOverlay {
  return {
    id: "o1",
    kind: "three",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { x: 10, y: 20, width: 100, height: 50 },
    opacity: 1,
    sceneFunction: "// scene",
    ...over,
  };
}

/** A `place3d` image overlay (non-`three`) — the camera chip must NOT render. */
function makeImageOverlay(over: Partial<ImageOverlay> = {}): ImageOverlay {
  return {
    id: "img1",
    kind: "image",
    startTime: 0,
    duration: 1,
    z: 0,
    rect: { x: 10, y: 20, width: 100, height: 50 },
    opacity: 1,
    fileId: "f1",
    place3d: true,
    ...over,
  } as ImageOverlay;
}

const composition = {
  width: 1920,
  height: 1080,
} as unknown as Composition;

/** A spy edit store that records every `preview`/`commit`/`cancelPreview`. */
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

function renderGizmo(
  props: Partial<React.ComponentProps<typeof ThreeGizmoControls>> = {},
  editStore?: OverlayEditStore,
) {
  return render(
    <OverlayEditStoreProvider value={editStore ?? makeEditStore()}>
      <ThreeGizmoControls
        composition={composition}
        overlay={(props.overlay as Overlay) ?? makeThreeOverlay()}
        canvasDisplayWidth={960}
        canvasDisplayHeight={540}
        onCommit={vi.fn()}
        {...props}
      />
    </OverlayEditStoreProvider>,
  );
}

describe("ThreeGizmoControls (always-Move; depth + rotation live in the inspector)", () => {
  it("renders the root + the always-on Move base layer (no depth thumb, no rotate rings here)", () => {
    renderGizmo();
    expect(screen.getByTestId("three-gizmo-controls")).toBeInTheDocument();
    expect(screen.getByTestId("overlay-move-body")).toBeInTheDocument();
    // Depth moved out to the inspector "Depth (Z)" slider — no orange thumb on canvas.
    expect(screen.queryByTestId("gizmo-depth")).not.toBeInTheDocument();
    // Rotation moved out to ThreeRotateDial — no rings in the on-canvas gizmo.
    expect(screen.queryByTestId("gizmo-ring-angle")).not.toBeInTheDocument();
    expect(screen.queryByTestId("gizmo-ring-elevation")).not.toBeInTheDocument();
    expect(screen.queryByTestId("orient-targets")).not.toBeInTheDocument();
  });

  it("renders a corner label that is pointer-events-none", () => {
    renderGizmo();
    const label = screen.getByTestId("gizmo-label");
    expect(label).toBeInTheDocument();
    expect(label).toHaveClass("pointer-events-none");
  });

  it("locked: no depth thumb, never previews/commits", () => {
    const onCommit = vi.fn();
    const editStore = makeEditStore();
    renderGizmo({ overlay: makeThreeOverlay(), locked: true, onCommit }, editStore);
    expect(screen.queryByTestId("gizmo-depth")).not.toBeInTheDocument();
    expect(onCommit).not.toHaveBeenCalled();
    expect(editStore.preview).not.toHaveBeenCalled();
  });

  it("never renders the removed camera chip (cameraPreset is no longer a UI control)", () => {
    renderGizmo({ overlay: makeThreeOverlay({ cameraPreset: "billboard" }) });
    expect(screen.queryByTestId("gizmo-camera")).not.toBeInTheDocument();
  });

  it("positions the on-canvas gizmo box at displayRect (the projected content rect)", () => {
    const three = makeThreeOverlay({ rect: { x: 0, y: 0, width: 1920, height: 1080 } });
    renderGizmo({
      overlay: three,
      displayRect: { x: 200, y: 100, width: 300, height: 80 },
    });
    const box = screen.getByTestId("three-gizmo-controls");
    // scaleX = 960/1920 = 0.5, scaleY = 540/1080 = 0.5 → box mirrors displayRect.
    expect(box).toHaveStyle({ left: "100px", top: "50px", width: "150px", height: "40px" });
  });

  // Regression: preview-player's non-text mount must thread a real
  // getCanvasBounds so the move base layer's bounds-consuming paths work.
  it("threads a real getCanvasBounds to the non-text base layer (move works)", () => {
    const onCommit = vi.fn();
    const getCanvasBounds = vi.fn(
      () => ({ left: 0, top: 0, width: 960, height: 540 }) as DOMRect,
    );
    renderGizmo({ overlay: makeImageOverlay(), onCommit, getCanvasBounds });

    const moveBody = screen.getByTestId("overlay-move-body");
    fireEvent.mouseDown(moveBody, { clientX: 100, clientY: 100 });
    fireEvent.mouseMove(window, { clientX: 130, clientY: 100 });
    fireEvent.mouseUp(window);
    expect(onCommit).toHaveBeenCalled();
    const movePatch = onCommit.mock.calls[onCommit.mock.calls.length - 1][0];
    expect(movePatch.rect).toBeDefined();
    // +30 display px / (960/1920 scaleX = 0.5) = +60 composition px from x=10.
    expect(movePatch.rect.x).toBeCloseTo(70, 6);
  });
});

describe("OverlayTransformControls — three never frames on the spatial quad", () => {
  function renderTC(overlay: Overlay) {
    return render(
      <OverlayEditStoreProvider value={makeEditStore()}>
        <OverlayTransformControls
          composition={composition}
          overlay={overlay}
          canvasDisplayWidth={960}
          canvasDisplayHeight={540}
          getCanvasBounds={() => null}
          onCommit={vi.fn()}
        />
      </OverlayEditStoreProvider>,
    );
  }

  // A steeply pitched transform whose projected content bounds went degenerate
  // (no displayRect): a non-three spatial overlay frames on the foreshortened
  // flat quad, but a `three` overlay must keep its full axis-aligned viewport
  // rect — its tilt is camera/scene-driven, so the flat quad would collapse the
  // gizmo to an ungrabbable sliver.
  const pitched = { ...IDENTITY_TRANSFORM3D, rotation: { x: 1.4, y: 0, z: 0 } };

  it("a pitched non-three (image) overlay DOES frame spatial (flat quad)", () => {
    renderTC(makeImageOverlay({ transform3d: pitched }));
    expect(screen.getByTestId("overlay-transform-controls")).toHaveAttribute(
      "data-spatial",
      "true",
    );
  });

  it("a pitched three overlay does NOT frame spatial — full viewport rect, grabbable", () => {
    const three = makeThreeOverlay({
      rect: { x: 200, y: 100, width: 600, height: 400 },
      transform3d: pitched,
    });
    renderTC(three);
    const box = screen.getByTestId("overlay-transform-controls");
    expect(box).toHaveAttribute("data-spatial", "false");
    expect(box).toHaveStyle({ left: "100px", top: "50px", width: "300px", height: "200px" });
  });
});
