// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { ChatMediaCard } from "@/components/chat/chat-media-card";
import type { ChatMediaPayload } from "@/lib/chat/chat-media";

const base = (over: Partial<ChatMediaPayload>): ChatMediaPayload => ({
  fileId: "f1",
  kind: "image",
  contentType: "image/png",
  filename: "shot.png",
  ...over,
});

describe("ChatMediaCard", () => {
  it("renders an <img> for an image payload at the content URL", () => {
    const { container } = render(<ChatMediaCard payload={base({ kind: "image" })} />);
    const img = container.querySelector("img");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/api/files/by-id/f1/content");
  });

  it("renders a <video> player for a video payload", () => {
    const { container } = render(
      <ChatMediaCard payload={base({ kind: "video", contentType: "video/mp4", filename: "take.mp4" })} />,
    );
    const video = container.querySelector("video");
    expect(video).toBeInTheDocument();
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("src", "/api/files/by-id/f1/content");
  });

  it("renders an <audio> player for an audio payload", () => {
    const { container } = render(
      <ChatMediaCard payload={base({ kind: "audio", contentType: "audio/mpeg", filename: "vo.mp3" })} />,
    );
    const audio = container.querySelector("audio");
    expect(audio).toBeInTheDocument();
    expect(audio).toHaveAttribute("controls");
  });

  it("shows the caption when present", () => {
    const { getByText } = render(
      <ChatMediaCard payload={base({ kind: "image", caption: "Scene 1 sketch" })} />,
    );
    expect(getByText("Scene 1 sketch")).toBeInTheDocument();
  });
});
