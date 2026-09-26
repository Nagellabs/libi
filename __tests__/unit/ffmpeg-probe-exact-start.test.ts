/**
 * probeMedia's start times are exact: `start_pts` × `time_base`, not
 * ffprobe's 6-decimal `start_time` (review round 4). A late audio track in
 * MPEG-TS (0.3786667 s after the video, 34080 ticks at 90 kHz) printed as
 * 1.845333 − 1.466667 = 0.378666 s, and the ffmpeg paths that pad it by that
 * much (`audioRead.ptsShift`, asetpts) placed it a sample early.
 */
import { describe, it, expect, vi } from "vitest";

let out: unknown = {};
vi.mock("child_process", () => ({
  execFile: (...callArgs: unknown[]) => {
    const cb = callArgs[callArgs.length - 1] as (e: Error | null, o: { stdout: string; stderr: string }) => void;
    cb(null, { stdout: JSON.stringify(out), stderr: "" });
  },
}));

import { probeMedia } from "@/lib/ffmpeg/probe";
import { onFileTimeline } from "@/lib/export/export-base";

describe("probeMedia: exact start times", () => {
  it("a late track in MPEG-TS: the lead and its read shift to the tick", async () => {
    out = {
      format: { format_name: "mpegts", start_time: "1.466667", duration: "5" },
      streams: [
        { index: 0, codec_type: "video", codec_name: "h264", time_base: "1/90000", start_pts: 132000, start_time: "1.466667" },
        { index: 1, codec_type: "audio", codec_name: "aac", time_base: "1/90000", start_pts: 166080, start_time: "1.845333" },
      ],
    };
    const p = await probeMedia("/x.ts");
    expect(p.startTime).toBe(132000 / 90000);
    expect(p.audioStart).toBeCloseTo(34080 / 90000, 12);
    expect(p.audioRead?.ptsShift).toBeCloseTo(34080 / 90000, 12);
    // …and the filter carries it to the sample (9 decimals).
    expect(onFileTimeline(p.audioRead!.ptsShift)).toContain("PTS+round(0.378666667/TB)");
  });

  it("without start_pts, the printed start_time", async () => {
    out = {
      format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", start_time: "0.025057", duration: "5" },
      streams: [{ index: 0, codec_type: "audio", codec_name: "aac", start_time: "0.025057" }],
    };
    const p = await probeMedia("/x.m4a");
    expect(p.startTime).toBe(0.025057);
    expect(p.audioStart).toBe(0);
  });
});
