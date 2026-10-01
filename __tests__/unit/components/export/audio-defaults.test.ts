import { describe, it, expect } from "vitest";
import { audioRequest, defaultIncluded, exportSummary, isIncluded, overridesAfterPurpose, type ExportAudioTrack } from "@/components/export/audio-defaults";

const T = (fileId: string, rights: ExportAudioTrack["rights"]): ExportAudioTrack => ({ fileId, label: fileId, fileType: "audio", rights });
const tracks = [T("song", "copyrighted"), T("vo", "generated"), T("clip", "owned"), T("mystery", null)];

describe("export audio defaults (addendum §7)", () => {
  it("copyrighted: off for Social, on for Personal; everything else on", () => {
    expect(tracks.map((t) => defaultIncluded(t, "social"))).toEqual([false, true, true, true]);
    expect(tracks.map((t) => defaultIncluded(t, "personal"))).toEqual([true, true, true, true]);
  });

  it("switching purpose re-applies the default to copyrighted tracks only", () => {
    const o = { song: true, vo: false };
    const after = overridesAfterPurpose(tracks, o);
    expect(after).toEqual({ vo: false });
    expect(isIncluded(tracks[0], "social", after)).toBe(false);
    expect(isIncluded(tracks[1], "personal", after)).toBe(false);
  });

  it("the request: copyrighted kept in via includeFileIds, anything else left out via excludeFileIds", () => {
    expect(audioRequest(tracks, "social", { song: true, clip: false })).toEqual({ purpose: "social", copyrightedAudio: "exclude", includeFileIds: ["song"], excludeFileIds: ["clip"] });
    expect(audioRequest(tracks, "personal", {})).toEqual({ purpose: "personal", copyrightedAudio: "exclude", includeFileIds: ["song"], excludeFileIds: [] });
  });

  it("the footer summary", () => {
    expect(exportSummary("mp4", "1080p", tracks.slice(0, 3), "social", {})).toBe("MP4 · 1080p · 2 of 3 audio tracks");
    expect(exportSummary("webm", "Original", [T("a", "owned")], "social", {})).toBe("WEBM · Original · 1 of 1 audio track");
    expect(exportSummary("mp4", "4K", [], "social", {})).toBe("MP4 · 4K · no audio");
  });
});
