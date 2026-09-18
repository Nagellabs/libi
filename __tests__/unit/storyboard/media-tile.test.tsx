// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { MediaTile } from "@/components/storyboard/card/media-tile";

afterEach(cleanup);

const thumb = () => screen.getByTestId("media-tile-thumb") as HTMLElement;

describe("MediaTile aspect", () => {
  it("defaults to the 64×114 portrait box", () => {
    render(<MediaTile kind="image" src="/x.png" label="start keyframe" />);
    expect(thumb().style.width).toBe("64px");
    expect(thumb().style.height).toBe("114px");
  });

  it("takes the card's aspect hint before the image has loaded", () => {
    render(<MediaTile kind="image" src="/x.png" aspect={16 / 9} label="sketch" />);
    expect(thumb().style.width).toBe("114px");
    expect(thumb().style.height).toBe("64px");
  });

  it("corrects the box to the image's intrinsic aspect on load", () => {
    render(<MediaTile kind="image" src="/x.png" label="sketch" />);
    const img = screen.getByRole("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 1280, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 720, configurable: true });
    fireEvent.load(img);
    expect(thumb().style.width).toBe("114px");
    expect(thumb().style.height).toBe("64px");
  });

  it("ignores a load that reports no size (broken image keeps the hint)", () => {
    render(<MediaTile kind="image" src="/x.png" aspect={1} label="sketch" />);
    const img = screen.getByRole("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 0, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 0, configurable: true });
    fireEvent.load(img);
    expect(thumb().style.width).toBe("114px");
    expect(thumb().style.height).toBe("114px");
  });

  it("re-measures when the src changes (a regenerated sketch)", () => {
    const { rerender } = render(<MediaTile kind="image" src="/a.png" label="sketch" />);
    const img = screen.getByRole("img") as HTMLImageElement;
    Object.defineProperty(img, "naturalWidth", { value: 1280, configurable: true });
    Object.defineProperty(img, "naturalHeight", { value: 720, configurable: true });
    fireEvent.load(img);
    expect(thumb().style.width).toBe("114px");
    rerender(<MediaTile kind="image" src="/b.png" label="sketch" />);
    expect(thumb().style.width).toBe("64px");
    expect(thumb().style.height).toBe("114px");
  });

  it("uses the video's metadata for take tiles", () => {
    const { container } = render(<MediaTile kind="video" src="/t.mp4" width={62} label="A" />);
    const video = container.querySelector("video") as HTMLVideoElement;
    Object.defineProperty(video, "videoWidth", { value: 1920, configurable: true });
    Object.defineProperty(video, "videoHeight", { value: 1080, configurable: true });
    fireEvent.loadedMetadata(video);
    expect(thumb().style.width).toBe("110px");
    expect(thumb().style.height).toBe("62px");
  });
});
