// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/components/preview/waveform", () => ({ Waveform: () => null }));

import AudioClipRow from "@/components/preview/audio-clip-row";
import type { AudioClip } from "@/lib/engine/types";

const clip: AudioClip = { id: "c1", kind: "standalone", fileId: "f1", startTime: 0, duration: 2, trimStart: 0, volume: 1, enabled: true };

describe("AudioClipRow © badge", () => {
  it("shows the badge with its tooltip on a copyrighted clip", () => {
    render(<AudioClipRow clip={clip} totalSeconds={4} audible={false} copyrighted onToggleEnabled={() => {}} onContextMenu={() => {}} />);
    expect(screen.getByTestId("copyright-badge")).toHaveAttribute("title", "Copyrighted — left out of social exports by default");
  });

  it("shows nothing for generated or owned music", () => {
    render(<AudioClipRow clip={clip} totalSeconds={4} audible={false} onToggleEnabled={() => {}} onContextMenu={() => {}} />);
    expect(screen.queryByTestId("copyright-badge")).toBeNull();
  });
});
