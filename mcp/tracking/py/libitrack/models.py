"""Shared model-path resolver for libitrack.

Honors the ``LIBI_TRACK_MODELS`` environment variable; defaults to
``~/.libi/models/tracking``.
"""
import os


def models_dir() -> str:
    """Return the absolute path to the tracking model directory."""
    return os.environ.get(
        "LIBI_TRACK_MODELS", os.path.expanduser("~/.libi/models/tracking")
    )


def model_path(name: str) -> str:
    """Return the absolute path for a model file by filename."""
    return os.path.join(models_dir(), name)
