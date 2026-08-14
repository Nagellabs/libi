// @vitest-environment jsdom
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { Film } from "lucide-react";
import { TrackRail, RAIL_WIDTH } from "@/components/preview/track-rail";

describe("TrackRail", () => {
  it("renders the label as the hover title and exposes the width constant", () => {
    render(<TrackRail icon={Film} label="Video" />);
    expect(screen.getByTestId("track-rail-Video")).toHaveAttribute("title", "Video");
    expect(RAIL_WIDTH).toBe(28);
  });

  it("calls onClick when provided (collapse toggle)", () => {
    const onClick = vi.fn();
    render(<TrackRail icon={Film} label="captions" onClick={onClick} />);
    fireEvent.click(screen.getByTestId("track-rail-captions"));
    expect(onClick).toHaveBeenCalledOnce();
  });
});
