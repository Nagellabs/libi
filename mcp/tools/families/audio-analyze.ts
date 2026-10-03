import { audioMeasureSchema, audioReportSchema, audioAlignSchema } from "@/mcp/tools/schemas";
import { audioMeasure, audioReport, audioAlign } from "@/mcp/tools/audio-analyze-tools";
import { action, type ActionToolDef } from "@/mcp/tools/action-tool";

export const audioAnalyzeTool: ActionToolDef = {
  name: "libi.audio_analyze",
  description:
    "Measure a piece's audio instead of guessing, and never decode or mix it yourself in ffmpeg or numpy: how loud the mix is (LUFS, RMS, peak), why a clip is quiet or silent somewhere, and where a clip's sound sits inside a longer file (the continuation point of a song). Actions: measure, report, align. Read-only.",
  props: {
    pieceId: "The piece.",
  },
  actions: {
    measure: action({
      describe:
        "renders the mix through the EXPORT path (ducks, gain, envelopes, fades, crossfades) over `ranges` and returns per range { lufs (integrated), shortTermMaxLufs, rmsDb, peakDb, silent } (dB; -90 = silence); with per 'clip' also each clip's own level. A few seconds; an unchanged piece answers `cached`. Use it to set a bed's gain (aim for the bed ~12-18 LUFS under the voice) and to check the result: measure, don't guess",
      schema: audioMeasureSchema,
      run: (params, extra) => audioMeasure(params, extra as Parameters<typeof audioMeasure>[1]),
    }),
    report: action({
      describe:
        "per clip over [from, to]: its effective level as parallel arrays t / gainDb (volume x gainDb x envelope x fades x crossfade) / duckDb (the real duck from the narration's actual level, not an estimate) / outDb, plus `quiet` spans (at or under -40 dB) with the cause, and `silentClips` (disabled, hidden layer, no audio stream) that should sound but do not. One call for 'why is the music silent at 74 s'. dB is relative to the file at unity: 0 = as recorded",
      schema: audioReportSchema,
      run: (params) => audioReport(params),
    }),
    align: action({
      describe:
        "finds where `referenceClipId`'s audio sits inside `fileId`: { offsetSec, endsAtSec (the continuation point), confidence 0-1, alternatives }. Below ~0.35 confidence the match is ambiguous (a repeated chorus): narrow `window`, do not trust it",
      schema: audioAlignSchema,
      run: (params, extra) => audioAlign(params, extra as Parameters<typeof audioAlign>[1]),
    }),
  },
};
