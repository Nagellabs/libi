# test-clip-12s.wav

12 s, 48 kHz stereo. Purely synthetic — **no external recording, no copyrighted
music**. Generated locally with `ffmpeg` (`lavfi` sources: `sine`, `anoisesrc`)
by tiling a single 0.5 s "beat" unit (a decaying 60 Hz kick, a highpass-noise
hi-hat on the offbeat, and a steady 110 Hz bass tone) 24 times, giving a clean,
exactly periodic 120 BPM click track with tonal content — enough for
`analyze.py` (librosa) to return a plausible tempo, beat grid, and key
estimate without pulling in any rights-encumbered audio.

Replaces a prior binary of the same name that had no provenance documentation
and could not be verified as clean (git history for this repo starts at a
single squashed commit, so there was no commit trail to check, and the file
carried no source/license metadata). Rather than guess, it was regenerated
from scratch.

Regenerate with:

```bash
SB=$(mktemp -d)
ffmpeg -y -f lavfi -i "sine=frequency=60:duration=0.5" \
  -af "afade=t=out:st=0:d=0.45,volume=1.0" "$SB/kick.wav"
ffmpeg -y -f lavfi -i "anoisesrc=color=white:duration=0.5:amplitude=1.0" \
  -af "highpass=f=6000,adelay=250|250,afade=t=in:st=0.25:d=0.01,afade=t=out:st=0.3:d=0.15,volume=0.6" \
  "$SB/hat.wav"
ffmpeg -y -f lavfi -i "sine=frequency=110:duration=0.5" -af "volume=0.22" "$SB/bass.wav"
ffmpeg -y -i "$SB/kick.wav" -i "$SB/hat.wav" -i "$SB/bass.wav" \
  -filter_complex "[0:a][1:a][2:a]amix=inputs=3:duration=first:normalize=0[out]" \
  -map "[out]" -ar 48000 -ac 1 -sample_fmt s16 -t 0.5 "$SB/beat_unit.wav"
ffmpeg -y -stream_loop 23 -i "$SB/beat_unit.wav" \
  -filter_complex "[0:a]pan=stereo|c0=c0|c1=c0[out]" \
  -map "[out]" -ar 48000 -ac 2 -sample_fmt s16 -t 12.0 \
  __tests__/fixtures/music/test-clip-12s.wav
```

Used only by `__tests__/integration/music/analyze-roundtrip.test.ts`, which is
opt-in (`LIBI_TEST_INTEGRATION=1`) and needs a real `librosa` install via `uv`.
