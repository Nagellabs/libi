// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

let audio: { data?: unknown; isLoading: boolean; isError: boolean; refetch: () => void };
vi.mock("@/lib/queries/audio-rights", () => ({ usePieceAudioRights: () => audio }));
vi.mock("@/lib/queries/social", () => ({ useSocialStatus: () => ({ data: { connected: false } }), useSocialAccounts: () => ({ data: [] }) }));
vi.mock("@/lib/queries/social-music", () => ({ useSocialMusicFacts: () => ({ data: undefined }) }));

import { useExportAudioTracks } from "@/lib/queries/export-audio";

const DATA = { copyrighted: [], ownMusic: [{ fileId: "g", name: "g.mp3", fileType: "audio", class: "generated" }] };

beforeEach(() => {
  audio = { data: DATA, isLoading: false, isError: false, refetch: vi.fn() };
});

describe("useExportAudioTracks", () => {
  it("a failed background refetch with the rights already loaded is not an error: Export stays enabled (M6)", () => {
    audio = { ...audio, isError: true };
    const { result } = renderHook(() => useExportAudioTracks("p1"));
    expect(result.current.isError).toBe(false);
    expect(result.current.tracks.map((t) => t.fileId)).toEqual(["g"]);
  });

  it("a failed first read (nothing loaded) is an error", () => {
    audio = { data: undefined, isLoading: false, isError: true, refetch: vi.fn() };
    const { result } = renderHook(() => useExportAudioTracks("p1"));
    expect(result.current.isError).toBe(true);
    expect(result.current.tracks).toEqual([]);
  });
});
