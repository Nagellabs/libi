// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProviderSuggestionCard } from "@/components/chat/provider-suggestion-card";
import type { ProviderSuggestionPayload } from "@/lib/chat/provider-suggestion";

const music: ProviderSuggestionPayload = {
  kind: "music",
  covered: [],
  suggested: [
    { id: "ace-step", name: "ACE-Step (on-device music)", kinds: ["music"], kind: "extension", extensionId: "local-music", sizeNote: "~8.3 GB" },
    { id: "elevenlabs", name: "ElevenLabs", kinds: ["voice", "music", "sfx"], kind: "remote-mcp" },
  ],
};

describe("ProviderSuggestionCard", () => {
  it("headlines the kind and offers one link per suggestion, on-device as Install with its size", () => {
    render(<ProviderSuggestionCard payload={music} sessionId="sess-1" />);
    expect(screen.getByText("To make music you need a provider")).toBeInTheDocument();

    const links = screen.getAllByRole("link");
    expect(links).toHaveLength(2);

    const install = screen.getByRole("link", { name: /Install ACE-Step \(on-device music\)/ });
    expect(install).toHaveAttribute("href", "/agents?tab=libi-mcp&extension=local-music&from=sess-1");
    expect(install).toHaveTextContent("~8.3 GB");

    const connect = screen.getByRole("link", { name: /Connect ElevenLabs/ });
    expect(connect).toHaveAttribute("href", "/agents?tab=providers&provider=elevenlabs&from=sess-1");
  });

  it("labels a kind in words and falls back to the raw kind for one it does not know", () => {
    const { rerender } = render(<ProviderSuggestionCard payload={{ ...music, kind: "sfx" }} sessionId={null} />);
    expect(screen.getByText("To make sound effects you need a provider")).toBeInTheDocument();
    rerender(<ProviderSuggestionCard payload={{ ...music, kind: "holograms" }} sessionId={null} />);
    expect(screen.getByText("To make holograms you need a provider")).toBeInTheDocument();
  });

  it("omits from= when the card has no session", () => {
    render(<ProviderSuggestionCard payload={music} sessionId={null} />);
    expect(screen.getByRole("link", { name: /Connect ElevenLabs/ })).toHaveAttribute(
      "href",
      "/agents?tab=providers&provider=elevenlabs",
    );
  });

  it("says what the user already has, and says nothing when they have none", () => {
    const { rerender } = render(<ProviderSuggestionCard payload={music} sessionId="sess-1" />);
    expect(screen.queryByText(/You already have/)).not.toBeInTheDocument();
    rerender(
      <ProviderSuggestionCard
        payload={{ ...music, covered: [{ id: "kokoro", name: "Kokoro", via: "extension" }, { id: "fal", name: "fal.ai", via: "connected" }] }}
        sessionId="sess-1"
      />,
    );
    expect(screen.getByText(/You already have/)).toHaveTextContent("You already have: Kokoro, fal.ai.");
  });

  it("never asks for a key: no input of any kind, and every link is a pointer", () => {
    const { container } = render(<ProviderSuggestionCard payload={music} sessionId="sess-1" />);
    expect(container.querySelector("input, textarea, [contenteditable]")).toBeNull();
    for (const link of screen.getAllByRole("link")) expect(link).toHaveClass("cursor-pointer");
  });
});
