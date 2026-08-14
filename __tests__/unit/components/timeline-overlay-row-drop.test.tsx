// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, createEvent } from "@testing-library/react";
import { TimelineOverlayRow } from "@/components/preview/timeline-overlay-row";
import type { LayerRowVM } from "@/lib/overlays/layers-view-model";
import { LIBI_FILE_MIME, encodeFileDrag } from "@/lib/preview/drag-payload";

const row: LayerRowVM = {
  group: "graphics",
  subLaneCount: 1,
  layers: [],
};

function makeDataTransfer(libi: string, files: File[] = []) {
  return {
    getData: (m: string) => (m === LIBI_FILE_MIME ? libi : ""),
    files: files as unknown as FileList,
    dropEffect: "",
  };
}

/** Build a drop event carrying clientX + dataTransfer (jsdom's generic drop
 *  event ignores those in the fireEvent init bag, so we set them on the
 *  constructed event directly). */
function fireDrop(lane: HTMLElement, clientX: number, dataTransfer: unknown) {
  const ev = createEvent.drop(lane);
  Object.defineProperty(ev, "clientX", { value: clientX });
  Object.defineProperty(ev, "dataTransfer", { value: dataTransfer });
  fireEvent(lane, ev);
}

describe("TimelineOverlayRow drop targets", () => {
  it("drop of an image file payload creates an image overlay at the resolved time", () => {
    const onDropCreate = vi.fn();
    const { container } = render(
      <TimelineOverlayRow
        row={row}
        timingById={{}}
        view={{ trackWidth: 1000, totalFrames: 300, fps: 30 }}
        collapsed={false}
        onSelect={() => {}}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
        durationSec={10}
        rowGroup="graphics"
        rowZ={2}
        frameSize={{ width: 1920, height: 1080 }}
        onDropCreate={onDropCreate}
        onDropFiles={() => {}}
      />,
    );
    const lane = container.querySelector(
      '[data-testid="overlay-lane-graphics"]',
    ) as HTMLElement;
    lane.getBoundingClientRect = () =>
      ({
        left: 0,
        width: 1000,
        top: 0,
        height: 20,
        right: 1000,
        bottom: 20,
        x: 0,
        y: 0,
        toJSON() {},
      }) as DOMRect;

    const dataTransfer = makeDataTransfer(
      encodeFileDrag({ fileId: "img1", contentType: "image/png" }),
    );
    // drop at clientX=500 → 50% of 10s = 5s
    fireDrop(lane, 500, dataTransfer);

    expect(onDropCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "image", fileId: "img1", z: 2, group: "graphics" }),
    );
    expect(onDropCreate.mock.calls[0][0].startTime).toBeCloseTo(5, 1);
  });

  it("classifies a video content-type payload as a video overlay", () => {
    const onDropCreate = vi.fn();
    const { container } = render(
      <TimelineOverlayRow
        row={row}
        timingById={{}}
        view={{ trackWidth: 1000, totalFrames: 300, fps: 30 }}
        collapsed={false}
        onSelect={() => {}}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
        durationSec={10}
        rowGroup="graphics"
        rowZ={2}
        onDropCreate={onDropCreate}
      />,
    );
    const lane = container.querySelector(
      '[data-testid="overlay-lane-graphics"]',
    ) as HTMLElement;
    lane.getBoundingClientRect = () =>
      ({ left: 0, width: 1000, top: 0, height: 20, right: 1000, bottom: 20, x: 0, y: 0, toJSON() {} }) as DOMRect;

    fireDrop(
      lane,
      0,
      makeDataTransfer(encodeFileDrag({ fileId: "vid1", contentType: "video/mp4" })),
    );
    expect(onDropCreate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "video", fileId: "vid1", startTime: 0 }),
    );
  });

  it("an OS file (no libi payload) routes to onDropFiles for the host to upload", () => {
    const onDropFiles = vi.fn();
    const { container } = render(
      <TimelineOverlayRow
        row={row}
        timingById={{}}
        view={{ trackWidth: 1000, totalFrames: 300, fps: 30 }}
        collapsed={false}
        onSelect={() => {}}
        onCommitTiming={() => {}}
        onCrossRow={() => {}}
        durationSec={10}
        rowGroup="graphics"
        rowZ={2}
        onDropFiles={onDropFiles}
      />,
    );
    const lane = container.querySelector(
      '[data-testid="overlay-lane-graphics"]',
    ) as HTMLElement;
    lane.getBoundingClientRect = () =>
      ({ left: 0, width: 1000, top: 0, height: 20, right: 1000, bottom: 20, x: 0, y: 0, toJSON() {} }) as DOMRect;

    const file = new File(["x"], "drop.png", { type: "image/png" });
    fireDrop(lane, 500, makeDataTransfer("", [file]));

    expect(onDropFiles).toHaveBeenCalledTimes(1);
    const [passedFile, resolved] = onDropFiles.mock.calls[0];
    expect(passedFile).toBe(file);
    expect(resolved.kind).toBe("image");
    expect(resolved.group).toBe("graphics");
    expect(resolved.startTime).toBeCloseTo(5, 1);
  });
});
