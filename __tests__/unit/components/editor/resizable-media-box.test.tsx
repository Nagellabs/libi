// @vitest-environment jsdom
import React from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ResizableMediaBox,
  containBox,
  readStoredMediaSize,
  writeStoredMediaSize,
  clearStoredMediaSize,
  MEDIA_BOX_PADDING,
} from "@/components/editor/resizable-media-box";

// jsdom has no ResizeObserver — install a controllable fake so tests can
// drive container measurements.
type RoCallback = (entries: { contentRect: { width: number; height: number } }[]) => void;
let roCallbacks: RoCallback[] = [];

class FakeResizeObserver {
  cb: RoCallback;
  constructor(cb: RoCallback) {
    this.cb = cb;
    roCallbacks.push(cb);
  }
  observe() {}
  disconnect() {}
}

function measure(w: number, h: number) {
  act(() => {
    for (const cb of roCallbacks) cb([{ contentRect: { width: w, height: h } }]);
  });
}

beforeEach(() => {
  roCallbacks = [];
  localStorage.clear();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("containBox", () => {
  it("fits a wide box by width", () => {
    expect(containBox(800, 1000, 16 / 9)).toEqual({ w: 800, h: 450 });
  });

  it("fits a tall container by height", () => {
    expect(containBox(800, 225, 16 / 9)).toEqual({ w: 400, h: 225 });
  });

  it("returns null for degenerate inputs", () => {
    expect(containBox(0, 100, 1)).toBeNull();
    expect(containBox(100, -1, 1)).toBeNull();
    expect(containBox(100, 100, 0)).toBeNull();
    expect(containBox(100, 100, NaN)).toBeNull();
  });
});

describe("stored media size", () => {
  it("round-trips per asset", () => {
    writeStoredMediaSize("a1", { w: 320, h: 180 });
    expect(readStoredMediaSize("a1")).toEqual({ w: 320, h: 180 });
    expect(readStoredMediaSize("a2")).toBeNull();
    clearStoredMediaSize("a1");
    expect(readStoredMediaSize("a1")).toBeNull();
  });

  it("ignores corrupt entries", () => {
    localStorage.setItem("libi:asset-media-size:bad", "not json");
    expect(readStoredMediaSize("bad")).toBeNull();
    localStorage.setItem("libi:asset-media-size:bad", JSON.stringify({ w: -5, h: 0 }));
    expect(readStoredMediaSize("bad")).toBeNull();
  });
});

describe("ResizableMediaBox", () => {
  const box = () => screen.getByTestId("media-box");

  it("auto-fits the media to the measured container minus padding", () => {
    render(
      <ResizableMediaBox assetId="v1" aspect={16 / 9}>
        <div data-testid="media" />
      </ResizableMediaBox>,
    );
    measure(832 + MEDIA_BOX_PADDING * 2, 1000);
    expect(box().style.width).toBe("832px");
    expect(box().style.height).toBe("468px");
  });

  it("applies a stored manual size on mount", () => {
    writeStoredMediaSize("v1", { w: 300, h: 200 });
    render(
      <ResizableMediaBox assetId="v1" aspect={16 / 9}>
        <div />
      </ResizableMediaBox>,
    );
    measure(800, 600);
    expect(box().style.width).toBe("300px");
    expect(box().style.height).toBe("200px");
  });

  it("reverts to auto-fit and clears storage when the container resizes", () => {
    writeStoredMediaSize("v1", { w: 300, h: 200 });
    render(
      <ResizableMediaBox assetId="v1" aspect={16 / 9}>
        <div />
      </ResizableMediaBox>,
    );
    measure(800, 600);
    expect(box().style.width).toBe("300px");
    // User drags the panel separator → container shrinks.
    measure(800, 400);
    expect(readStoredMediaSize("v1")).toBeNull();
    const expected = containBox(800 - MEDIA_BOX_PADDING * 2, 400 - MEDIA_BOX_PADDING * 2, 16 / 9)!;
    expect(box().style.width).toBe(`${expected.w}px`);
    expect(box().style.height).toBe(`${expected.h}px`);
  });

  it("ignores zero-size measurements from hidden keep-mounted tabs", () => {
    writeStoredMediaSize("v1", { w: 300, h: 200 });
    render(
      <ResizableMediaBox assetId="v1" aspect={16 / 9}>
        <div />
      </ResizableMediaBox>,
    );
    measure(800, 600);
    measure(0, 0); // tab hidden
    measure(800, 600); // tab shown again, same size
    expect(readStoredMediaSize("v1")).toEqual({ w: 300, h: 200 });
    expect(box().style.width).toBe("300px");
  });

  it("drag-resizing the handle persists the size for the asset", () => {
    render(
      <ResizableMediaBox assetId="v1" aspect={2}>
        <div />
      </ResizableMediaBox>,
    );
    measure(432, 1000); // auto: 400×200
    const handle = screen.getByRole("button", { name: /resize media/i });
    (handle as HTMLElement & { setPointerCapture: () => void }).setPointerCapture = () => {};
    fireEvent.pointerDown(handle, { clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(handle, { clientX: 200, clientY: 100, pointerId: 1 });
    expect(box().style.width).toBe("500px");
    expect(box().style.height).toBe("250px");
    fireEvent.pointerUp(handle, { pointerId: 1 });
    expect(readStoredMediaSize("v1")).toEqual({ w: 500, h: 250 });
  });

  it("double-clicking the handle resets to auto-fit", () => {
    writeStoredMediaSize("v1", { w: 300, h: 150 });
    render(
      <ResizableMediaBox assetId="v1" aspect={2}>
        <div />
      </ResizableMediaBox>,
    );
    measure(432, 1000);
    const handle = screen.getByRole("button", { name: /resize media/i });
    fireEvent.doubleClick(handle);
    expect(readStoredMediaSize("v1")).toBeNull();
    expect(box().style.width).toBe("400px"); // contain(400, 968, 2)
    expect(box().style.height).toBe("200px");
  });
});
