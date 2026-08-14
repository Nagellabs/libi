#!/usr/bin/env python3
"""
ACE-Step / local-music ANALYZE entrypoint.

CLI (mirrors mcp/music/generate.py):
  --mode beats|profile        (required)
  --in <audio-path>           (required)
  --out <json-path>           (required)
  --include-beats             (profile mode: also include beats[])
  --band-envelopes            (profile mode: also include 3-band RMS)
  --envelope-hz <int>         (default 10)
  --start <seconds>           (default 0)
  --end <seconds>             (default 300 — 5-min cap)

Writes the JSON envelope to --out, exits 0 on success, 2 on usage error,
1 on runtime error. Never prints to stdout (the TS wrapper parses only
the --out file). Stderr is free for librosa warnings + tracebacks.

Run via:
  uv run --python 3.12 --with librosa==0.11.0 --with soundfile python analyze.py …
"""
from __future__ import annotations

import argparse
import json
import sys
import traceback
from pathlib import Path

MAX_SECONDS = 300.0  # 5 minutes


def _load_audio(path: str, start: float, end: float):
    import librosa  # local import: spec is "pay the load cost only when the script runs"

    duration_native = librosa.get_duration(path=path)
    truncated = False
    if end > duration_native:
        end = duration_native
    if (end - start) > MAX_SECONDS:
        end = start + MAX_SECONDS
        truncated = True
    y, sr = librosa.load(path, sr=22050, offset=start, duration=end - start, mono=True)
    if y.size == 0:
        raise RuntimeError("audio_empty: loaded 0 samples")
    return y, sr, end - start, truncated


def _beats(y, sr, min_bpm: float, max_bpm: float):
    import librosa
    import numpy as np

    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo, beat_frames = librosa.beat.beat_track(
        onset_envelope=onset_env, sr=sr, bpm=None, tightness=100
    )
    tempo_val = float(tempo) if np.isscalar(tempo) else float(tempo[0])
    beat_times = librosa.frames_to_time(beat_frames, sr=sr).tolist()
    onset_frames = librosa.onset.onset_detect(onset_envelope=onset_env, sr=sr)
    onset_times = librosa.frames_to_time(onset_frames, sr=sr).tolist()
    # Confidence proxy: variance of the inter-beat interval (lower = steadier).
    if len(beat_times) >= 3:
        intervals = np.diff(beat_times)
        cov = float(np.std(intervals) / max(np.mean(intervals), 1e-6))
        confidence = max(0.0, min(1.0, 1.0 - cov))
    else:
        confidence = 0.0
    # Clamp to user-supplied bpm window if it's outside.
    if not (min_bpm <= tempo_val <= max_bpm):
        confidence *= 0.5  # we kept the librosa estimate but flag it
    return tempo_val, confidence, beat_times, onset_times


KRUMHANSL_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
KRUMHANSL_MINOR = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]
PITCH_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def _key_estimate(y, sr):
    import librosa
    import numpy as np

    chroma = librosa.feature.chroma_cqt(y=y, sr=sr).mean(axis=1)

    def best(profile):
        scores = []
        for k in range(12):
            rotated = np.roll(profile, k)
            corr = float(np.corrcoef(chroma, rotated)[0, 1])
            scores.append((corr, k))
        scores.sort(reverse=True)
        return scores[0]  # (corr, tonic_idx)

    maj_corr, maj_idx = best(KRUMHANSL_MAJOR)
    min_corr, min_idx = best(KRUMHANSL_MINOR)
    if maj_corr >= min_corr:
        return {"tonic": PITCH_NAMES[maj_idx], "mode": "major", "confidence": round(max(0.0, maj_corr), 3)}
    return {"tonic": PITCH_NAMES[min_idx], "mode": "minor", "confidence": round(max(0.0, min_corr), 3)}


def _describe(tempo, key, energy, brightness, percussiveness, duration):
    # Order matters: _suggested_prompt indexes into this list positionally.
    # 0=tempo, 1=key, 2=timbre, 3=energy, 4=optional percussiveness tag.
    # If you add/remove entries here, update _suggested_prompt accordingly.
    descriptors = []
    if tempo < 80: descriptors.append("slow tempo")
    elif tempo < 110: descriptors.append("moderate tempo")
    else: descriptors.append("uptempo")
    descriptors.append(f"{key['tonic']} {key['mode']}")
    descriptors.append("dark" if brightness < 0.4 else ("bright" if brightness > 0.7 else "balanced timbre"))
    descriptors.append("mellow" if energy < 0.4 else ("energetic" if energy > 0.7 else "moderate energy"))
    if percussiveness > 0.7: descriptors.append("rhythm-forward")
    elif percussiveness < 0.3: descriptors.append("sustained / harmonic")
    return descriptors


def _suggested_prompt(tempo, key, descriptors, duration):
    minutes = round(duration / 60.0, 1)
    return (
        f"A {descriptors[2]} piece at {round(tempo)} BPM in {descriptors[1]}, "
        f"{descriptors[0]}, {descriptors[3]}"
        f"{', ' + descriptors[4] if len(descriptors) > 4 else ''}. "
        f"~{minutes} min."
    )


def _profile(y, sr, include_beats: bool, band_envelopes: bool, envelope_hz: int, duration: float):
    import librosa
    import numpy as np

    # Tempo + (optional) beat times
    onset_env = librosa.onset.onset_strength(y=y, sr=sr)
    tempo_arr, beat_frames = librosa.beat.beat_track(onset_envelope=onset_env, sr=sr)
    tempo_val = float(tempo_arr) if np.isscalar(tempo_arr) else float(tempo_arr[0])
    intervals = np.diff(librosa.frames_to_time(beat_frames, sr=sr)) if len(beat_frames) >= 3 else np.array([])
    tempo_conf = (
        max(0.0, min(1.0, 1.0 - float(np.std(intervals) / max(np.mean(intervals), 1e-6))))
        if intervals.size else 0.0
    )
    key = _key_estimate(y, sr)
    rms = float(np.mean(librosa.feature.rms(y=y)))
    energy = max(0.0, min(1.0, rms * 5.0))  # rough perceptual map
    centroid = float(np.mean(librosa.feature.spectral_centroid(y=y, sr=sr)))
    brightness = max(0.0, min(1.0, centroid / (sr / 2)))
    harmonic, percussive = librosa.effects.hpss(y)
    # Proxy: HPSS doesn't perfectly partition y into harmonic+percussive
    # (residual is dropped), so this ratio is monotonic with "percussive content"
    # but not a true [0,1] energy fraction. The clamp catches stray > 1.
    p_ratio = float(np.sum(percussive ** 2) / max(np.sum(y ** 2), 1e-9))
    percussiveness = max(0.0, min(1.0, p_ratio))
    # Loudness-ish: mean-square energy + BS.1770 absolute-gating offset.
    # NOT true K-weighted LUFS (no RLB high-pass / high-shelf pre-filter),
    # so bass-heavy content reads ~3 LUFS hotter than a real meter would.
    # Use as a relative loudness indicator within libi only.
    import math
    lufs = -0.691 + 10 * math.log10(max(np.mean(y ** 2), 1e-9))
    descriptors = _describe(tempo_val, key, energy, brightness, percussiveness, duration)
    out = {
        "durationSeconds": round(duration, 3),
        "tempo": round(tempo_val, 2),
        "tempoConfidence": round(tempo_conf, 3),
        "keyEstimate": key,
        "energyMean": round(energy, 3),
        "brightnessMean": round(brightness, 3),
        "percussiveness": round(percussiveness, 3),
        "loudnessLufs": round(lufs, 1),
        "descriptors": descriptors,
        "suggestedPrompt": _suggested_prompt(tempo_val, key, descriptors, duration),
    }
    if include_beats:
        out["beats"] = {"times": librosa.frames_to_time(beat_frames, sr=sr).tolist()}
    if band_envelopes:
        # Resample RMS curves to envelope_hz. Three bands: bass <250Hz, mid 250–4kHz, treble >4kHz.
        S = np.abs(librosa.stft(y, n_fft=2048, hop_length=512))
        freqs = librosa.fft_frequencies(sr=sr, n_fft=2048)
        times = librosa.frames_to_time(np.arange(S.shape[1]), sr=sr, hop_length=512)
        # Guard: clips shorter than one STFT hop produce S.shape[1] == 0; clips
        # smaller than 1/envelope_hz produce an empty target grid. Return empty
        # arrays rather than crashing — the consumer can still render an envelope.
        if S.shape[1] == 0 or times[-1] <= 0:
            out["bands"] = {
                "sampleRateHz": envelope_hz,
                "bass": [],
                "mid": [],
                "treble": [],
            }
        else:
            bands = {
                "bass": S[(freqs < 250)].mean(axis=0),
                "mid": S[(freqs >= 250) & (freqs < 4000)].mean(axis=0),
                "treble": S[freqs >= 4000].mean(axis=0),
            }
            target_dt = 1.0 / envelope_hz
            target_t = np.arange(0, times[-1], target_dt)

            def resample(curve):
                return np.interp(target_t, times, curve / max(curve.max(), 1e-9)).tolist()

            out["bands"] = {
                "sampleRateHz": envelope_hz,
                "bass": resample(bands["bass"]),
                "mid": resample(bands["mid"]),
                "treble": resample(bands["treble"]),
            }
    return out


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["beats", "profile"], required=True)
    parser.add_argument("--in", dest="in_path", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--include-beats", action="store_true")
    parser.add_argument("--band-envelopes", action="store_true")
    parser.add_argument("--envelope-hz", type=int, default=10)
    parser.add_argument("--start", type=float, default=0.0)
    parser.add_argument("--end", type=float, default=MAX_SECONDS)
    parser.add_argument("--min-bpm", type=float, default=40.0)
    parser.add_argument("--max-bpm", type=float, default=240.0)
    try:
        args = parser.parse_args()
    except SystemExit:
        sys.exit(2)

    if not Path(args.in_path).exists():
        print(f"file_not_found: {args.in_path}", file=sys.stderr)
        sys.exit(1)

    try:
        y, sr, duration, truncated = _load_audio(args.in_path, args.start, args.end)
        if args.mode == "beats":
            tempo, conf, beats_t, onsets_t = _beats(y, sr, args.min_bpm, args.max_bpm)
            envelope = {
                "ok": True,
                "tempo": round(tempo, 2),
                "tempoConfidence": round(conf, 3),
                "beatTimes": [round(t, 4) for t in beats_t],
                "onsetTimes": [round(t, 4) for t in onsets_t],
                "durationSeconds": round(duration, 3),
                "truncated": truncated,
            }
        else:
            payload = _profile(
                y, sr, args.include_beats, args.band_envelopes, args.envelope_hz, duration
            )
            payload["ok"] = True
            payload["truncated"] = truncated
            envelope = payload
        Path(args.out).write_text(json.dumps(envelope))
    except Exception as e:
        msg = f"{type(e).__name__}: {e}"
        if "audio_empty" in str(e):
            print("audio_empty: input has no decodable samples", file=sys.stderr)
        else:
            print(msg, file=sys.stderr)
            traceback.print_exc(file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
