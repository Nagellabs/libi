// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useTransport } from "@/hooks/preview/use-transport";

beforeEach(() => {
  localStorage.clear();
});

describe("useTransport master volume", () => {
  it("defaults to volume=1, muted=false", () => {
    const { result } = renderHook(() => useTransport({ totalFrames: 100, fps: 30 }));
    expect(result.current.masterVolume).toBe(1);
    expect(result.current.masterMuted).toBe(false);
  });

  it("clamps setMasterVolume into 0..1", () => {
    const { result } = renderHook(() => useTransport({ totalFrames: 100, fps: 30 }));
    act(() => result.current.setMasterVolume(2));
    expect(result.current.masterVolume).toBe(1);
    act(() => result.current.setMasterVolume(-3));
    expect(result.current.masterVolume).toBe(0);
  });

  it("toggleMasterMuted flips and persists", () => {
    const { result } = renderHook(() => useTransport({ totalFrames: 100, fps: 30 }));
    act(() => result.current.toggleMasterMuted());
    expect(result.current.masterMuted).toBe(true);
    expect(localStorage.getItem("libi:preview-muted")).toBe("true");
  });

  it("hydrates from localStorage", () => {
    localStorage.setItem("libi:preview-volume", "0.4");
    localStorage.setItem("libi:preview-muted", "true");
    const { result } = renderHook(() => useTransport({ totalFrames: 100, fps: 30 }));
    expect(result.current.masterVolume).toBeCloseTo(0.4);
    expect(result.current.masterMuted).toBe(true);
  });
});
