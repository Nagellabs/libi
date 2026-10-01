// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

let file: Record<string, unknown> | null = null;
const mutate = vi.fn();
vi.mock("@/lib/queries/files", () => ({ useFileById: () => ({ data: file, isLoading: false }) }));
vi.mock("@/lib/queries/audio-rights", () => ({ useUpdateAudioRights: () => ({ mutate, isPending: false, error: null }) }));
vi.mock("@/components/preview/song-on-social", () => ({ SongOnSocial: () => <div data-testid="song-on-social" /> }));

import { AudioRightsSection, AUTOSAVE_MS } from "@/components/preview/audio-rights-section";

const copyrighted = (track?: object) => JSON.stringify({ class: "copyrighted", ...(track ? { track } : {}), decidedBy: "provenance", decidedAt: "x" });

beforeEach(() => {
  vi.useFakeTimers();
  mutate.mockReset();
  file = { id: "f1", type: "audio", hasAudio: true, audioRights: null, createdAt: "2026-09-27T00:00:00.000Z" };
});
afterEach(() => vi.useRealTimers());

describe("AudioRightsSection — title and artist", () => {
  it("are labelled, one per line, auto-growing text areas; there is no Save button", () => {
    render(<AudioRightsSection fileId="f1" />);
    expect(screen.getByLabelText("Title").tagName).toBe("TEXTAREA");
    expect(screen.getByLabelText("Artist").tagName).toBe("TEXTAREA");
    expect(screen.getByTestId("audio-rights-title")).toHaveAttribute("rows", "1");
    expect(screen.queryByTestId("audio-rights-save")).toBeNull();
  });

  it("save 600 ms after the last keystroke, once, and say Saved", () => {
    expect(AUTOSAVE_MS).toBe(600);
    render(<AudioRightsSection fileId="f1" />);
    fireEvent.change(screen.getByTestId("audio-rights-title"), { target: { value: "Espresso" } });
    act(() => { vi.advanceTimersByTime(300); });
    fireEvent.change(screen.getByTestId("audio-rights-artist"), { target: { value: "Sabrina Carpenter" } });
    act(() => { vi.advanceTimersByTime(599); });
    expect(mutate).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ fileId: "f1", track: { title: "Espresso", artist: "Sabrina Carpenter" } }, expect.objectContaining({ onSuccess: expect.any(Function) }));
    act(() => { (mutate.mock.calls[0][1] as { onSuccess: () => void }).onSuccess(); });
    expect(screen.getByTestId("audio-rights-saved")).toHaveTextContent("Saved");
  });

  it("save immediately on blur", () => {
    render(<AudioRightsSection fileId="f1" />);
    fireEvent.change(screen.getByTestId("audio-rights-title"), { target: { value: "Espresso" } });
    fireEvent.blur(screen.getByTestId("audio-rights-title"));
    expect(mutate).toHaveBeenCalledTimes(1);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("an empty title is not saved (the last good value stays)", () => {
    file = { ...file!, audioRights: copyrighted({ title: "Espresso" }) };
    render(<AudioRightsSection fileId="f1" />);
    fireEvent.change(screen.getByTestId("audio-rights-title"), { target: { value: "  " } });
    fireEvent.blur(screen.getByTestId("audio-rights-title"));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(mutate).not.toHaveBeenCalled();
  });

  it("keeps album and isrc, promotes low confidence to high, and clears a removed artist", () => {
    file = { ...file!, audioRights: copyrighted({ title: "Espresso (Official Video)", artist: "SabrinaVEVO", album: "Short n' Sweet", isrc: "USUM72401994", trackConfidence: "low" }) };
    render(<AudioRightsSection fileId="f1" />);
    fireEvent.change(screen.getByTestId("audio-rights-title"), { target: { value: "Espresso" } });
    fireEvent.change(screen.getByTestId("audio-rights-artist"), { target: { value: "" } });
    fireEvent.blur(screen.getByTestId("audio-rights-artist"));
    expect(mutate.mock.calls[0][0]).toEqual({ fileId: "f1", track: { title: "Espresso", album: "Short n' Sweet", isrc: "USUM72401994", trackConfidence: "high" } });
  });
});

describe("AudioRightsSection — switching files and unmounting", () => {
  it("a pending debounced edit is saved to the OLD file when the selected file changes without a blur", () => {
    const { rerender } = render(<AudioRightsSection fileId="f1" />);
    fireEvent.change(screen.getByTestId("audio-rights-title"), { target: { value: "Espresso" } });
    // No blur, no timer advance: the debounce hasn't fired when the file switches.
    file = { id: "f2", type: "audio", hasAudio: true, audioRights: null, createdAt: "2026-09-27T00:00:00.000Z" };
    rerender(<AudioRightsSection fileId="f2" />);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ fileId: "f1", track: { title: "Espresso" } }, expect.objectContaining({ onSuccess: expect.any(Function) }));
    // Nothing is ever sent for the file just switched to.
    expect(mutate.mock.calls.every((c) => (c[0] as { fileId: string }).fileId === "f1")).toBe(true);
  });

  it("a pending debounced edit is saved once on unmount, and the debounce timer doesn't fire again after", () => {
    const { unmount } = render(<AudioRightsSection fileId="f1" />);
    fireEvent.change(screen.getByTestId("audio-rights-title"), { target: { value: "Espresso" } });
    unmount();
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ fileId: "f1", track: { title: "Espresso" } }, expect.objectContaining({ onSuccess: expect.any(Function) }));
    act(() => { vi.advanceTimersByTime(1000); });
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

describe("AudioRightsSection — dedupe and the Saved tick", () => {
  it("a blur right after an autosave doesn't send a duplicate (dedupes against the last value sent, not only server state)", () => {
    render(<AudioRightsSection fileId="f1" />);
    fireEvent.change(screen.getByTestId("audio-rights-title"), { target: { value: "Espresso" } });
    act(() => { vi.advanceTimersByTime(AUTOSAVE_MS); });
    expect(mutate).toHaveBeenCalledTimes(1);
    // The mocked file never "refetches" — rights.track is still stale — so a
    // blur landing right after must not resend the identical value.
    fireEvent.blur(screen.getByTestId("audio-rights-title"));
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it("a failed save is sent again on the next blur (M4)", () => {
    render(<AudioRightsSection fileId="f1" />);
    fireEvent.change(screen.getByTestId("audio-rights-title"), { target: { value: "Espresso" } });
    fireEvent.blur(screen.getByTestId("audio-rights-title"));
    expect(mutate).toHaveBeenCalledTimes(1);
    act(() => { (mutate.mock.calls[0][1] as { onError: () => void }).onError(); });
    fireEvent.blur(screen.getByTestId("audio-rights-title"));
    expect(mutate).toHaveBeenCalledTimes(2);
    expect(mutate.mock.calls[1][0]).toEqual({ fileId: "f1", track: { title: "Espresso" } });
  });

  it("a second save before the first Saved tick expires doesn't hide it early", () => {
    render(<AudioRightsSection fileId="f1" />);
    fireEvent.change(screen.getByTestId("audio-rights-title"), { target: { value: "Espresso" } });
    fireEvent.blur(screen.getByTestId("audio-rights-title"));
    act(() => { (mutate.mock.calls[0][1] as { onSuccess: () => void }).onSuccess(); });
    expect(screen.getByTestId("audio-rights-saved")).toHaveTextContent("Saved");
    act(() => { vi.advanceTimersByTime(1000); }); // 1s into the first save's 2s tick
    fireEvent.change(screen.getByTestId("audio-rights-title"), { target: { value: "Espresso 2" } });
    fireEvent.blur(screen.getByTestId("audio-rights-title"));
    act(() => { (mutate.mock.calls[1][1] as { onSuccess: () => void }).onSuccess(); });
    act(() => { vi.advanceTimersByTime(1000); }); // the FIRST tick's original deadline passes now
    expect(screen.getByTestId("audio-rights-saved")).toHaveTextContent("Saved");
    act(() => { vi.advanceTimersByTime(1000); }); // the SECOND save's own 2s tick has now elapsed
    expect(screen.queryByTestId("audio-rights-saved")).toBeNull();
  });
});

describe("AudioRightsSection — rights", () => {
  it("reads an unstamped upload as the user's own (owner decision 2026-09-28)", () => {
    render(<AudioRightsSection fileId="f1" />);
    expect(screen.getByTestId("audio-rights-line")).toHaveTextContent("Yours");
    expect(screen.getByTestId("audio-rights-owned")).toBeChecked();
  });

  it("says copyrighted and offers 'I own this'; the On social block follows", () => {
    file = { ...file!, audioRights: copyrighted() };
    render(<AudioRightsSection fileId="f1" />);
    expect(screen.getByTestId("audio-rights-line")).toHaveTextContent("Copyrighted");
    fireEvent.click(screen.getByTestId("audio-rights-owned"));
    expect(mutate).toHaveBeenCalledWith({ fileId: "f1", class: "owned" });
    expect(screen.getByTestId("song-on-social")).toBeInTheDocument();
  });
});
