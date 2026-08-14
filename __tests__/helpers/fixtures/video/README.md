# Video test fixtures

Committed binary fixtures used by the video-pipeline integration tests.

| File | Contents |
|---|---|
| `clip-red-3s.mp4` | 3s, 320×240, solid red, H.264 + AAC (1 kHz sine at -20 dB) |
| `clip-green-3s.mp4` | 3s, 320×240, solid green, H.264 + AAC (440 Hz sine at -20 dB) |
| `tone-5s.m4a` | 5s mono AAC tone at 660 Hz (for audio-mix tests) |
| `logo-64.png` | 64×64 solid blue PNG (for image-overlay tests) |

## Regenerating

Fixtures are produced by `generate.sh` (requires `ffmpeg` on PATH). Output is deterministic per ffmpeg version — different ffmpeg releases may produce byte-different output, that's fine.

```bash
./generate.sh
```

Then commit the regenerated binaries alongside any related code changes.

## Sizes

Total committed bytes land under ~200 KB. If any regenerated file balloons past ~500 KB, re-check the `ffmpeg` flags (codec, preset, bitrate) before committing.
