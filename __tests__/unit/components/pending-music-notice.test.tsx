// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

let manifest: Record<string, unknown> = {};
vi.mock("@/lib/queries/pieces", () => ({ usePieceComposition: () => ({ data: { manifest, audioClips: [] } }) }));
import { PendingMusicNotice } from "@/components/preview/pending-music-notice";

it("says which template song is not included", () => {
  manifest = { width: 1, height: 1, fps: 30, pendingMusic: [{ assetId: "a", templateId: "t", track: { title: "Espresso", artist: "Sabrina Carpenter" }, clips: [] }] };
  render(<PendingMusicNotice pieceId="p" />);
  expect(screen.getByTestId("pending-music-notice")).toHaveTextContent("Music not included: Espresso — Sabrina Carpenter");
});

it("renders nothing without pending music", () => {
  manifest = { width: 1, height: 1, fps: 30 };
  const { container } = render(<PendingMusicNotice pieceId="p" />);
  expect(container).toBeEmptyDOMElement();
});

it("isolates the song label's direction", () => {
  manifest = { width: 1, height: 1, fps: 30, pendingMusic: [{ assetId: "a", templateId: "t", track: { title: "שיר" }, clips: [] }] };
  render(<PendingMusicNotice pieceId="p" />);
  expect(screen.getByTestId("pending-music-notice").querySelector("bdi")).toHaveTextContent("שיר");
});
