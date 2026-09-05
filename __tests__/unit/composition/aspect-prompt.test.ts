import { describe, it, expect } from "vitest";
import { buildAspectChangePrompt } from "@/lib/composition/aspect-prompt";
import { ratioById } from "@/lib/composition/aspect-ratio";

const args = {
  pieceId: "p_abc123",
  pieceName: "Summer Launch",
  currentWidth: 1920,
  currentHeight: 1080,
  target: ratioById("9:16")!,
  targetWidth: 1080,
  targetHeight: 1920,
  overlayCount: 4,
};

describe("buildAspectChangePrompt", () => {
  const prompt = buildAspectChangePrompt(args);

  it("names the exact tool and arguments so it works pasted into any CLI", () => {
    // This same text is what a bring-your-own-CLI user copies. A prompt that
    // says "change the ratio" without naming the tool sends them hunting.
    expect(prompt).toContain("libi.update_composition_dimensions");
    expect(prompt).toContain('"p_abc123"');
    expect(prompt).toContain("width 1080");
    expect(prompt).toContain("height 1920");
  });

  it("states both the current and the target frame", () => {
    expect(prompt).toContain("1920x1080");
    expect(prompt).toContain("1080x1920");
    expect(prompt).toContain("16:9");
    expect(prompt).toContain("9:16");
  });

  it("names the orientation in words", () => {
    expect(prompt).toContain("landscape");
    expect(prompt).toContain("portrait");
  });

  it("asks for the reflow, not just the resize", () => {
    // The resize alone would strand every overlay outside the new frame.
    expect(prompt).toMatch(/reposition|rescale/i);
    expect(prompt).toContain("libi.retrieve_assets_dimensions");
  });

  it("includes the piece name for a human reading the chat", () => {
    expect(prompt).toContain("Summer Launch");
  });

  it("mentions how many overlays are affected", () => {
    expect(prompt).toContain("4");
  });

  it("uses singular wording for a single overlay", () => {
    const one = buildAspectChangePrompt({ ...args, overlayCount: 1 });
    expect(one).toContain("1 overlay");
    expect(one).not.toContain("1 overlays");
  });
});
