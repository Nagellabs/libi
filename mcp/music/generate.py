# mcp/music/generate.py
"""ACE-Step music entrypoint. Run via the bundled uv:

  uv run --python 3.12 --with "ace-step @ git+https://github.com/ace-step/ACE-Step.git@<sha>" python mcp/music/generate.py \
      --prompt-file <txt> [--lyrics-file <txt>] --duration 30 --seed 0 \
      --model-dir <dir> --out <wav> [--instrumental]

  # download/validate only (streams weights from HuggingFace into
  # --model-dir, NEVER loads them into RAM):
  uv run --python 3.12 --with "ace-step @ git+https://github.com/ace-step/ACE-Step.git@<sha>" python mcp/music/generate.py \
      --download-only --model-dir <dir>

Prints exactly ONE JSON object to stdout. Coarse progress lines
("PROGRESS <elapsed>/<eta>") go to STDERR so stdout stays single-JSON.
Errors -> stderr + exit 1; model-load failure -> stderr + exit 3.

Generation output:
  {"ok": true, "sample_rate": 48000, "duration_seconds": 30.0,
   "channels": 2, "instrumental": true, "seed": 12345}
Validate output: {"ok": true, "model": "ace-step",
                  "files_downloaded": <int>}

Memory: the download path uses huggingface_hub.snapshot_download which
streams bytes to disk file-by-file (~100 MB peak RAM). The generate path
loads the full ACE-Step pipeline (~7-9 GB resident with bf16/fp16,
~14-17 GB with fp32) — the host should free that before calling.

The exact ACE-Step pipeline API + pin is frozen by the gated Layer-2
E2E (LIBI_MUSIC_E2E=1). Bump ACESTEP_GIT_SHA / ACESTEP_MODEL_VERSION
in lib/music/models.ts if that test fails on resolution.
"""
import argparse
import json
import os
import sys
import threading
import time


# HF repo for ACE-Step v1-3.5B model weights. The libi-side manifest
# (`ACESTEP_FILES` in lib/music/models.ts) is the source of truth for
# what files we expect on disk; we mirror the repo here as a fallback.
HF_REPO_ID = "ACE-Step/ACE-Step-v1-3.5B"


def pick_device() -> str:
    try:
        import torch

        if torch.backends.mps.is_available():
            return "mps"
        if torch.cuda.is_available():
            return "cuda"
    except Exception:  # noqa: BLE001
        pass
    return "cpu"


def pick_dtype(device: str) -> str:
    """LIBI_ACESTEP_DTYPE env var overrides; defaults are memory-sane.
    float32 (the upstream default) needs ~14 GB just for the transformer;
    bf16/fp16 halves that with no quality loss for this model class."""
    override = os.environ.get("LIBI_ACESTEP_DTYPE", "").strip()
    if override:
        return override
    if device in ("mps", "cuda"):
        return "bfloat16"
    return "float16"


def progress_tqdm_class():
    """Build a tqdm subclass that emits `PROGRESS <done>/<total> files`
    markers on stderr for snapshot_download's outer file-count bar. The
    libi-side runUv parser turns those into JobManager progress ticks so
    the UI chip shows real download progress instead of a frozen 0/1.

    Returns None if tqdm can't be imported — progress is best-effort and
    must never block or break the download itself."""
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
                # snapshot_download's outer "Fetching N files" bar counts
                # files (unit != "B"); the per-file byte bars use unit "B".
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


def download_only(model_dir: str) -> int:
    """Stream model files from HuggingFace into model_dir without
    loading anything into RAM. Idempotent: snapshot_download skips
    files that are already present with matching hashes."""
    try:
        from huggingface_hub import snapshot_download
    except Exception as e:  # noqa: BLE001
        # huggingface_hub is a transitive dep of ace-step (via diffusers
        # + transformers). If even importing it fails, the venv is bad.
        print(f"huggingface_hub import failed: {e}", file=sys.stderr)
        return 1

    kwargs = dict(
        repo_id=HF_REPO_ID,
        local_dir=model_dir,
        # Skip .gitattributes / README — only weights + configs are needed.
        allow_patterns=["*.safetensors", "*.json", "*.txt"],
    )
    # Best-effort granular progress (PROGRESS <done>/<total> files on stderr).
    progress_cls = progress_tqdm_class()
    if progress_cls is not None:
        kwargs["tqdm_class"] = progress_cls

    try:
        snapshot_download(**kwargs)
    except Exception as e:  # noqa: BLE001
        print(f"snapshot_download failed: {e}", file=sys.stderr)
        return 1

    # Count what we actually have on disk now, for telemetry.
    n = 0
    for _, _, files in os.walk(model_dir):
        n += sum(1 for f in files if not f.startswith("."))
    print(json.dumps({"ok": True, "model": "ace-step", "files_downloaded": n}))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt-file")
    ap.add_argument("--lyrics-file")
    ap.add_argument("--duration", type=float, default=30.0)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--model-dir", required=True)
    ap.add_argument("--out")
    ap.add_argument("--instrumental", action="store_true")
    ap.add_argument("--download-only", action="store_true")
    args = ap.parse_args()

    os.makedirs(args.model_dir, exist_ok=True)

    # CRITICAL: download path never touches ACEStepPipeline. Pipeline
    # init loads ~17 GB of weights into RAM in fp32; doing that just to
    # "verify the download" OOM-killed users' machines.
    if args.download_only:
        return download_only(args.model_dir)

    if not args.out or not args.prompt_file:
        print("--prompt-file and --out required unless --download-only",
              file=sys.stderr)
        return 1

    try:
        from acestep.pipeline_ace_step import ACEStepPipeline
    except Exception as e:  # noqa: BLE001
        print(f"acestep import failed: {e}", file=sys.stderr)
        return 1

    device = pick_device()
    dtype = pick_dtype(device)

    try:
        pipeline = ACEStepPipeline(
            checkpoint_dir=args.model_dir,
            dtype=dtype,
            device=device,
        )
        # Triggers ACE-Step's own HF download into checkpoint_dir on a
        # cold cache; a no-op when weights are already present.
        pipeline.load_checkpoint(args.model_dir)
    except Exception as e:  # noqa: BLE001
        print(f"model load failed: {e}", file=sys.stderr)
        return 3

    try:
        with open(args.prompt_file, "r", encoding="utf-8") as fh:
            prompt = fh.read().strip()
        if not prompt:
            print("empty prompt", file=sys.stderr)
            return 1
        lyrics = ""
        if args.lyrics_file and not args.instrumental:
            with open(args.lyrics_file, "r", encoding="utf-8") as fh:
                lyrics = fh.read().strip()

        # Timer-based pseudo-progress (robust; no fragile internal hook).
        eta = max(1, int(args.duration * (0.6 if device == "mps" else 12)))
        start = time.time()
        stop = threading.Event()

        def ticker():
            while not stop.wait(2.0):
                elapsed = int(time.time() - start)
                print(f"PROGRESS {min(elapsed, eta)}/{eta}",
                      file=sys.stderr, flush=True)

        t = threading.Thread(target=ticker, daemon=True)
        t.start()
        try:
            pipeline(
                prompt=prompt,
                lyrics=lyrics,
                audio_duration=float(args.duration),
                infer_step=27,
                manual_seeds=str(args.seed),
                save_path=args.out,
            )
        finally:
            stop.set()

        import soundfile as sf

        info = sf.info(args.out)
        out = {
            "ok": True,
            "sample_rate": int(info.samplerate),
            "duration_seconds": round(float(info.frames) / float(info.samplerate), 3),
            "channels": int(info.channels),
            "instrumental": bool(args.instrumental or not lyrics),
            "seed": int(args.seed),
        }
        print(json.dumps(out))
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"generation failed: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
