// lib/uv-env/managed-python-size.ts
//
// What libi's own CPython costs the user, once. Every uv call runs with
// UV_PYTHON_PREFERENCE=only-managed (lib/uv-env/spawn-env.ts), so the first
// Python feature on a machine downloads a uv-managed interpreter into
// `<LIBI_HOME>/uv/python/`, and each Python feature's install disclosure must
// count it. A LEAF on purpose — no imports — because the provider catalog
// (`lib/providers/catalog.ts`, rendered in the browser) reads it.
//
// Measured 2026-09-25 on macOS arm64 with uv 0.11.32 / 0.12.19:
// cpython-3.12.13 23.8 MiB download → 66 MB on disk; cpython-3.11.15 25.9 MiB
// → 71 MB; 3.12.14 on a true new-user run → 70 MB. One interpreter per Python
// minor version (whisper / TTS / music / yt-dlp share 3.12; tracking uses 3.11).

/** Download size of one managed CPython, decimal MB, rounded. */
export const MANAGED_PYTHON_DOWNLOAD_MB = 25;

/** On-disk size of one managed CPython, decimal MB, rounded. */
export const MANAGED_PYTHON_DISK_MB = 70;
