"""faster-whisper entrypoint. Run via the bundled uv:

  uv run --with faster-whisper==1.1.1 python mcp/whisper/transcribe.py \
      <audio> --model small --download-root <dir> [--language en]

  # download-only (no audio arg needed):
  uv run --with faster-whisper==1.1.1 python mcp/whisper/transcribe.py \
      --download-only --model small --download-root <dir>

Prints exactly ONE JSON object to stdout. Errors -> stderr + exit 1.
Transcribe output shape == ElevenLabs /v1/speech-to-text:
  {"language_code","language_probability","text","words":[
     {"text","start","end","type":"word","speaker_id":null}]}
Download output: {"ok": true, "model": "<size>"}
"""
import argparse
import json
import sys


def progress_tqdm_class():
    """tqdm subclass emitting `PROGRESS <done>/<total> files` on stderr for
    snapshot_download's outer file-count bar. The libi-side runUv parser
    turns those into JobManager progress ticks so the UI chip shows real
    download progress instead of a frozen 0/1. Returns None if tqdm is
    unavailable — progress is best-effort and never blocks the download."""
    try:
        try:
            from huggingface_hub.utils import tqdm as _base
        except Exception:  # noqa: BLE001
            from tqdm.auto import tqdm as _base
    except Exception:  # noqa: BLE001
        return None

    class _ProgressTqdm(_base):  # type: ignore[misc, valid-type]
        def update(self, n=1):
            ret = super().update(n)
            try:
                if self.total and getattr(self, "unit", "") != "B":
                    print(
                        f"PROGRESS {int(self.n)}/{int(self.total)} files",
                        file=sys.stderr,
                        flush=True,
                    )
            except Exception:  # noqa: BLE001
                pass
            return ret

    return _ProgressTqdm


def install_progress_hook() -> None:
    """Best-effort: make faster-whisper's snapshot_download emit
    `PROGRESS <done>/<total> files` markers so the libi UI chip shows real
    download progress. Never raises — the download proceeds regardless."""
    cls = progress_tqdm_class()
    if cls is None:
        return
    try:
        import faster_whisper.utils as fw_utils

        original = fw_utils.snapshot_download

        def hooked(*args, **kwargs):
            kwargs.setdefault("tqdm_class", cls)
            return original(*args, **kwargs)

        fw_utils.snapshot_download = hooked
    except Exception:  # noqa: BLE001
        pass


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio", nargs="?", help="audio file path")
    ap.add_argument("--model", required=True)
    ap.add_argument("--download-root", required=True)
    ap.add_argument("--language", default=None)
    ap.add_argument("--download-only", action="store_true")
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except Exception as e:  # noqa: BLE001
        print(f"faster-whisper import failed: {e}", file=sys.stderr)
        return 1

    # Download-only runs install a best-effort progress hook before the
    # WhisperModel constructor triggers the HuggingFace download.
    if args.download_only:
        install_progress_hook()

    try:
        model = WhisperModel(
            args.model,
            device="cpu",
            compute_type="int8",
            download_root=args.download_root,
        )
    except Exception as e:  # noqa: BLE001
        print(f"model load failed: {e}", file=sys.stderr)
        return 1

    if args.download_only:
        print(json.dumps({"ok": True, "model": args.model}))
        return 0

    if not args.audio:
        print("audio path required unless --download-only", file=sys.stderr)
        return 1

    try:
        segments, info = model.transcribe(
            args.audio,
            language=args.language,
            word_timestamps=True,
        )
        words = []
        text_parts = []
        for seg in segments:
            text_parts.append(seg.text)
            for w in seg.words or []:
                words.append(
                    {
                        "text": w.word,
                        "start": round(float(w.start), 3),
                        "end": round(float(w.end), 3),
                        "type": "word",
                        "speaker_id": None,
                    }
                )
        out = {
            "language_code": info.language,
            "language_probability": round(float(info.language_probability), 4),
            "text": "".join(text_parts).strip(),
            "words": words,
        }
        print(json.dumps(out))
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"transcription failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
