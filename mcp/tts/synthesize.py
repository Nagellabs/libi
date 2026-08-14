# mcp/tts/synthesize.py
"""Kokoro-82M entrypoint. Run via the bundled uv:

  uv run --with kokoro-onnx==0.4.9 python mcp/tts/synthesize.py \
      --text-file <txt> --voice af_heart --speed 1.0 --lang en-us \
      --model-dir <dir> --out <wav> [--timestamps]

  # validate-only (no synthesis, warms the wheel cache):
  uv run --with kokoro-onnx==0.4.9 python mcp/tts/synthesize.py \
      --download-only --model-dir <dir>

Prints exactly ONE JSON object to stdout. Errors -> stderr + exit 1.
Synthesis output:
  {"ok": true, "voice": "af_heart", "sample_rate": 24000,
   "duration_seconds": 3.41,
   "words": [{"text": "Hello", "start": 0.0, "end": 0.42}], "approximate": true}
Validate output: {"ok": true, "model": "kokoro"}

Word timings are an APPROXIMATE proportional split of the measured audio
duration across whitespace tokens (monotonic, within [0, duration]).
"""
import argparse
import json
import os
import re
import sys


def model_files(model_dir):
    return (
        os.path.join(model_dir, "kokoro-v1.0.int8.onnx"),
        os.path.join(model_dir, "voices-v1.0.bin"),
    )


def approx_word_times(text, total):
    toks = [t for t in re.split(r"\s+", text.strip()) if t]
    if not toks:
        return []
    weights = [max(len(t), 1) for t in toks]
    tot_w = float(sum(weights))
    words = []
    acc = 0.0
    for tok, w in zip(toks, weights):
        start = acc
        acc += total * (w / tot_w)
        words.append(
            {"text": tok, "start": round(start, 3), "end": round(acc, 3)}
        )
    if words:
        words[-1]["end"] = round(total, 3)
    return words


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--text-file")
    ap.add_argument("--voice", default="af_heart")
    ap.add_argument("--speed", type=float, default=1.0)
    ap.add_argument("--lang", default="en-us")
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--out")
    ap.add_argument("--timestamps", action="store_true")
    ap.add_argument("--download-only", action="store_true")
    args = ap.parse_args()

    onnx, voices = model_files(args.model_dir)
    if not (os.path.isfile(onnx) and os.path.isfile(voices)):
        print(f"model files missing under {args.model_dir}", file=sys.stderr)
        return 1

    try:
        from kokoro_onnx import Kokoro
    except Exception as e:  # noqa: BLE001
        print(f"kokoro-onnx import failed: {e}", file=sys.stderr)
        return 1

    try:
        kokoro = Kokoro(onnx, voices)
    except Exception as e:  # noqa: BLE001
        print(f"model load failed: {e}", file=sys.stderr)
        return 1

    if args.download_only:
        print(json.dumps({"ok": True, "model": "kokoro"}))
        return 0

    if not args.text_file or not args.out:
        print("--text-file and --out required unless --download-only", file=sys.stderr)
        return 1

    try:
        with open(args.text_file, "r", encoding="utf-8") as fh:
            text = fh.read().strip()
        if not text:
            print("empty text", file=sys.stderr)
            return 1
        samples, sample_rate = kokoro.create(
            text, voice=args.voice, speed=args.speed, lang=args.lang
        )
        import soundfile as sf

        sf.write(args.out, samples, sample_rate)
        duration = round(float(len(samples)) / float(sample_rate), 3)
        out = {
            "ok": True,
            "voice": args.voice,
            "sample_rate": int(sample_rate),
            "duration_seconds": duration,
            "words": approx_word_times(text, duration) if args.timestamps else [],
            "approximate": True,
        }
        print(json.dumps(out))
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"synthesis failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
