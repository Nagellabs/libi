// @vitest-environment jsdom
//
// D6: a template's resources — every asset, shown the way its kind plays:
// an image as a thumbnail that opens full size, audio and video with their
// own controls, a local font with a sample line, a link-only asset by its
// host (inline only through libi's own stream route, when the page gives one:
// the app's CSP admits no arbitrary host), and a file the page may not serve
// as "Not available".
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { ResourcesList } from "@/components/templates/template-details/resources-list";
import type { ResourceRow } from "@/lib/templates/details";

afterEach(cleanup);

const rows: ResourceRow[] = [
  { ref: "logo", kind: "image", name: "logo.png", bytes: 2048, source: { kind: "file", url: "/api/templates/t1/media/logo.png" } },
  { ref: "bed", kind: "audio", name: "bed.mp3", bytes: null, source: { kind: "file", url: "/api/templates/t1/media/bed.mp3" } },
  { ref: "b-roll", kind: "video", name: "b-roll.mp4", bytes: 5_000_000, source: { kind: "file", url: "/api/templates/t1/media/b-roll.mp4" } },
  { ref: "clip", kind: "video", name: "clip.mp4", bytes: null, source: { kind: "link", url: "https://cdn.example.com/clip.mp4", host: "cdn.example.com" } },
  { ref: "vo", kind: "audio", name: "vo.mp3", bytes: null, source: { kind: "link", url: "https://audio.example.org/vo.mp3", host: "audio.example.org" } },
  { ref: "brand", kind: "font", name: "Brand.ttf", bytes: 9000, source: { kind: "file", url: "/api/templates/t1/media/Brand.ttf" } },
  { ref: "gone", kind: "image", name: "gone.png", bytes: null, source: { kind: "unavailable" } },
];

describe("ResourcesList", () => {
  it("an image is a lazy thumbnail; clicking it opens the full image in a dialog", async () => {
    render(<ResourcesList rows={rows} fontSamples />);
    const thumb = screen.getByTestId("resource-image-logo");
    expect(thumb).toHaveAttribute("loading", "lazy");
    const open = screen.getByTestId("resource-image-open-logo");
    expect(open.className).toContain("cursor-zoom-in");
    fireEvent.click(open);
    const full = await screen.findByTestId("resource-image-full");
    expect(full).toHaveAttribute("src", "/api/templates/t1/media/logo.png");
  });

  it("audio and video files play with their own controls, loading nothing until asked", () => {
    render(<ResourcesList rows={rows} fontSamples />);
    const audio = screen.getByTestId("resource-audio-bed");
    expect(audio.tagName).toBe("AUDIO");
    expect(audio).toHaveAttribute("controls");
    expect(audio).toHaveAttribute("preload", "none");
    const video = screen.getByTestId("resource-video-b-roll");
    expect(video.tagName).toBe("VIDEO");
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "none");
  });

  it("a link-only video or audio shows its host and an external Open link, never an inline player", () => {
    render(<ResourcesList rows={rows} fontSamples />);
    for (const [ref, host, href] of [["clip", "cdn.example.com", "https://cdn.example.com/clip.mp4"], ["vo", "audio.example.org", "https://audio.example.org/vo.mp3"]]) {
      const card = screen.getAllByTestId("resource-card").find((c) => c.getAttribute("data-ref") === ref)!;
      expect(within(card).getByText(host)).toBeInTheDocument();
      const link = within(card).getByTestId(`resource-link-${ref}`);
      expect(link).toHaveAttribute("href", href);
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer");
      expect(link.textContent).toContain("Open link");
      expect(link.className).toContain("cursor-pointer");
      expect(card.querySelector("video, audio")).toBeNull();
    }
  });

  it("a local font gets a sample line in its own face; the face name is sanitized", () => {
    const { container } = render(<ResourcesList rows={rows} fontSamples />);
    const sample = screen.getByTestId("resource-font-sample-brand");
    expect(sample.textContent).toBe("The quick brown fox jumps over the lazy dog");
    expect(sample.style.fontFamily).toContain("libi-template-font-brand");
    const css = container.querySelector("style")!.textContent!;
    expect(css).toContain('font-family: "libi-template-font-brand"');
    expect(css).toContain('url("/api/templates/t1/media/Brand.ttf")');
  });

  it("without samples (a public font) it shows the name and size only", () => {
    const { container } = render(<ResourcesList rows={rows} fontSamples={false} />);
    expect(screen.queryByTestId("resource-font-sample-brand")).toBeNull();
    expect(container.querySelector("style")).toBeNull();
    const card = screen.getAllByTestId("resource-card").find((c) => c.getAttribute("data-ref") === "brand")!;
    expect(within(card).getByText("Brand.ttf")).toBeInTheDocument();
    expect(within(card).getByText("8.8 KB")).toBeInTheDocument();
  });

  it("an asset the page may not serve says Not available", () => {
    render(<ResourcesList rows={rows} fontSamples />);
    const card = screen.getAllByTestId("resource-card").find((c) => c.getAttribute("data-ref") === "gone")!;
    expect(within(card).getByText("Not available")).toBeInTheDocument();
    expect(card.querySelector("img")).toBeNull();
  });

  it("no assets: says so", () => {
    render(<ResourcesList rows={[]} fontSamples />);
    expect(screen.getByText("No resources.")).toBeInTheDocument();
  });

  // D5–D6 follow-up: the owner asked to play each resource. A public template's link-only
  // audio/video plays through libi's stream route — only once Play is pressed.
  it("a link-only audio or video with a stream: a Play button, no media element (nothing fetched) until pressed; then a player on the stream, Open link kept", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    const streamed: ResourceRow[] = [
      { ref: "clip", kind: "video", name: "clip.mp4", bytes: null, source: { kind: "link", url: "https://cdn.example.com/clip.mp4", host: "cdn.example.com", stream: "/api/templates/cloud/asset-stream?cloudId=x&url=clip" } },
      { ref: "vo", kind: "audio", name: "vo.mp3", bytes: null, source: { kind: "link", url: "https://audio.example.org/vo.mp3", host: "audio.example.org", stream: "/api/templates/cloud/asset-stream?cloudId=x&url=vo" } },
    ];
    const { container } = render(<ResourcesList rows={streamed} fontSamples={false} />);
    expect(container.querySelectorAll("video, audio")).toHaveLength(0);
    const button = screen.getByTestId("resource-play-clip");
    expect(button.className).toContain("cursor-pointer");
    expect(button).toHaveAccessibleName("Play video 1 of 2");
    expect(button).toHaveAccessibleDescription("clip.mp4");
    expect(screen.getByTestId("resource-link-clip")).toHaveAttribute("href", "https://cdn.example.com/clip.mp4");
    fireEvent.click(button);
    const video = await screen.findByTestId("resource-video-clip");
    expect(video).toHaveAttribute("src", "/api/templates/cloud/asset-stream?cloudId=x&url=clip");
    expect(video).toHaveAttribute("preload", "none");
    expect(video).not.toHaveAttribute("autoplay");
    expect(video).toHaveAccessibleName("Video 1 of 2");
    expect(play).toHaveBeenCalled();
    // Open link stays as the other way.
    expect(screen.getByTestId("resource-link-clip")).toBeInTheDocument();
    // The audio is still just a button.
    expect(screen.queryByTestId("resource-audio-vo")).toBeNull();
    fireEvent.click(screen.getByTestId("resource-play-vo"));
    const audio = await screen.findByTestId("resource-audio-vo");
    fireEvent.error(audio);
    expect(await screen.findByTestId("resource-stream-failed-vo")).toHaveTextContent("Couldn’t play it here — open the link instead.");
  });

  it("names every media control by kind and position, and describes it by the resource's name — never the name as the label", () => {
    render(<ResourcesList rows={rows} fontSamples />);
    expect(screen.getByTestId("resource-image-open-logo")).toHaveAccessibleName("Show image 1 of 7 full size");
    expect(screen.getByTestId("resource-image-open-logo")).toHaveAccessibleDescription("logo.png");
    expect(screen.getByTestId("resource-audio-bed")).toHaveAccessibleName("Audio 2 of 7");
    expect(screen.getByTestId("resource-video-b-roll")).toHaveAccessibleName("Video 3 of 7");
    expect(screen.getByTestId("resource-video-b-roll")).toHaveAccessibleDescription("b-roll.mp4");
  });
});
