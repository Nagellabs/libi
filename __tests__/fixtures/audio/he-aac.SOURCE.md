# he-aac-*.m4a

Six short HE-AAC files, plus two videos, carrying synthetic tones (440 Hz left and 660 Hz right,
44.1 kHz, generated with ffmpeg's `sine` source; the mono ones are 440 Hz only). They
contain no third-party material.

| File | Signalling | AudioSpecificConfig |
|---|---|---|
| `he-aac-v2-backcompat.m4a` | HE-AACv2 (SBR + PS), backward-compatible sync extensions | `13 88 56 e5 a5 48 80` |
| `he-aac-v1-backcompat.m4a` | HE-AAC v1 (SBR), backward-compatible sync extension | `13 90 56 e5 a0` |
| `he-aac-v2-explicit.m4a` | HE-AACv2, explicit hierarchical (AOT 29) | `eb 8a 08 00 00 00 00` |
| `he-aac-v2-long-backcompat.m4a` | HE-AACv2, backward-compatible, **5 s / 111 packets** | `13 88 56 e5 a5 48 80` |
| `he-aac-v2-explicit-video.mp4` | `he-aac-v2-explicit.m4a`'s audio (stream-copied, same ASC) + 1 s of 32×32 `testsrc2` H.264 | `eb 8a 08 00 00 00 00` |
| `he-aac-v1-mono-backcompat.m4a` | HE-AAC v1 from a MONO source: SBR signalled on a mono core, no PS | `13 88 56 e5 a0` |
| `he-aac-v1-mono-long-backcompat.m4a` | the same, **5 s / 111 packets** | `13 88 56 e5 a0` |
| `he-aac-v1-mono-video.mp4` | `he-aac-v1-mono-backcompat.m4a`'s audio (stream-copied) + 1 s of 32×32 `testsrc2` H.264 | `13 88 56 e5 a0` |

How they were made (macOS):

```bash
ffmpeg -f lavfi -i "sine=f=440:d=1:r=44100" -f lavfi -i "sine=f=660:d=1:r=44100" \
  -filter_complex "[0][1]amerge=inputs=2" -c:a pcm_s16le tone.wav
afconvert -f m4af -d aacp -b 32000 tone.wav he-aac-v2-backcompat.m4a
afconvert -f m4af -d aach -b 48000 tone.wav he-aac-v1-backcompat.m4a
ffmpeg -f lavfi -i "sine=f=440:d=0.5:r=44100" -ac 1 tone-mono.wav
afconvert -f m4af -d aach -b 32000 tone-mono.wav he-aac-v1-mono-backcompat.m4a
ffmpeg -f lavfi -i "aevalsrc=0.3*sin(2*PI*440*t)|0.3*sin(2*PI*660*t):s=44100:d=5:c=stereo" -c:a pcm_s16le tone5.wav
afconvert -f m4af -d aacp -b 24000 tone5.wav he-aac-v2-long-backcompat.m4a
ffmpeg -f lavfi -i "aevalsrc=0.3*sin(2*PI*440*t):s=44100:d=5:c=mono" -c:a pcm_s16le tone5-mono.wav
afconvert -f m4af -d aach -b 32000 tone5-mono.wav he-aac-v1-mono-long-backcompat.m4a
```

The long files exist because mediabunny's sample sink keeps up to 40 packets in
flight: a decoder failure on a shorter file surfaces at flush no matter what, so
only a file of more than 40 packets can show whether an error hangs the
iterator (`he-aac-track.test.ts`).

Chromium decodes SBR on a mono core to stereo (ISO 14496-3 §1.6.5.3), so the mono
file fails the same way as the HE-AACv2 ones when it is configured as 1 channel.

`he-aac-v2-explicit.m4a` is `he-aac-v2-backcompat.m4a` with its 7-byte
DecoderSpecificInfo replaced in place by `eb 8a 08 00 00 00 00` — the ASC of the
TikTok clip in the Dreams / Ocean Spray pieces, zero-padded to the same length so
no box size changes. SBR and PS data travel in-band either way, so the frames are
the same; only the signalling differs. ffprobe reads it as HE-AACv2 44.1 kHz
stereo. mediabunny 1.40 handed it to WebCodecs as `{ mp4a.40.29, 1 ch, 22050 Hz }`,
the config Electron 36 rejects; 1.60 reports `{ 2 ch, 44100 Hz }` and it decodes
without repair.

With mediabunny 1.60 only the two mono-source files still reach WebCodecs as 1
channel (`{ mp4a.40.2, 1 ch, 44100 Hz }`), so they are the ones that exercise the
repair (`docs-local/qa/2026-09-25-mediabunny-upgrade-report.md`).

Why they exist: `docs-local/qa/2026-09-25-dreams-audio-report.md`.

`he-aac-v2-explicit-video.mp4` (for "video + HE-AAC", Re-review R3):

```bash
ffmpeg -f lavfi -i "testsrc2=s=32x32:r=10:d=1" -i he-aac-v2-explicit.m4a \
  -map 0:v -map 1:a -c:v libx264 -pix_fmt yuv420p -c:a copy -shortest he-aac-v2-explicit-video.mp4
```

`he-aac-v1-mono-video.mp4` (the same, for the case mediabunny 1.60 still reports as
1 channel):

```bash
ffmpeg -f lavfi -i "testsrc2=s=32x32:r=10:d=1" -i he-aac-v1-mono-backcompat.m4a \
  -map 0:v -map 1:a -c:v libx264 -pix_fmt yuv420p -c:a copy -shortest he-aac-v1-mono-video.mp4
```

# aac-lc-itunsmpb.m4a

A 3 s two-sweep chirp (no two stretches alike, so a cross-correlation has one
peak), encoded by Apple's AAC-LC encoder. afconvert resampled it to 32 kHz and
wrote the gapless tag `iTunSMPB` with 0x840 = 2112 samples of priming, so
ffmpeg starts the file at 2112 / 32000 = 0.066 s and skips those samples, while
mediabunny ignores the tag. All the HE-AAC files above carry the same tag
(ffmpeg: start 0.047891 s at 44.1 kHz). Synthetic, no third-party material.

```bash
ffmpeg -f lavfi -i "aevalsrc=0.3*sin(2*PI*(200+300*t)*t)+0.2*sin(2*PI*(1500-250*t)*t):s=44100:d=3:c=mono" \
  -ac 2 -c:a pcm_s16le chirp.wav
afconvert -f m4af -d aac -b 64000 chirp.wav aac-lc-itunsmpb.m4a
```

Used by `export-gapless-start.test.ts` (the export side of the start-time
agreement). docs-local/qa/2026-09-25-mediabunny-upgrade-report.md
