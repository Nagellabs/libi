# mcp/tts/espeak_path.py
"""Give espeak-ng a data path it can hold.

espeak-ng copies its data path into a 160-byte buffer (`path_home`), so a
path of 160+ characters is truncated and every phoneme lookup fails:

  Error processing file '…/archive-v0/<16>/lib//phontab': No such file …

The data dir ships inside the `espeakng_loader` wheel, deep in uv's cache
under <LIBI_HOME>: `~/.libi` gives ~120 characters, the packaged app's
`~/Library/Application Support/libi` ~147 for a 10-character username — so a
23+ character username, or any long LIBI_HOME, broke Kokoro (0.1.16 full
verification F7).

The fix is a SHORT copy of the directory, made of hard links (a plain copy
where a link can't be made — another volume, a filesystem without them).

Why not a symlink, a junction or a Windows 8.3 name: phonemizer's
`EspeakWrapper.data_path` calls `pathlib.Path.resolve()` on whatever it is
given, which follows symlinks and junctions and (on Windows) expands 8.3
names back to the long path. Measured with the pinned kokoro-onnx 0.4.9 /
phonemizer-fork 3.3.2: a /tmp symlink to the long dir fails exactly like the
long dir. A hard link has no "target" to resolve to.

Stdlib only, so it can be tested without kokoro installed
(mcp/tts/test_espeak_path.py).
"""
import atexit
import os
import shutil
import stat
import sys
import tempfile
import uuid

# espeak-ng's path_home is 160 BYTES including the NUL; keep a byte of margin.
# Every length below is measured in encoded bytes (`_plen`), not characters: a
# non-ASCII home of ~150 characters can be well over 159 bytes.
ESPEAK_PATH_LIMIT = 159
# <LIBI_HOME>/tts/esd is used only while it stays this short (bytes), so the
# data dir under it (+ "/espeak-ng-data") is far below the limit.
SHORT_HOME_MAX = 100
# How many `libi-esd-<uid>[-n]` names to try before a throwaway mkdtemp.
_TMP_NAME_TRIES = 8
DATA_DIR_NAME = "espeak-ng-data"
STAMP_NAME = ".libi-source"


class EspeakPathError(RuntimeError):
    pass


def _plen(p):
    """A path's length as espeak-ng sees it: encoded bytes."""
    return len(os.fsencode(p))


def _owned_private_dir(path, uid):
    """Create `path` 0700, or accept it only if it is a real directory (not a
    symlink) this user owns that nobody else can write."""
    try:
        os.mkdir(path, 0o700)
    except FileExistsError:
        pass
    st = os.lstat(path)
    return (
        stat.S_ISDIR(st.st_mode)
        and st.st_uid == uid
        and (st.st_mode & 0o022) == 0
    )


def _private_tmp_root(base, uid):
    """`<base>/libi-esd-<uid>`, created 0700 and ownership-checked.

    When someone else holds that name, the next STABLE name
    (`libi-esd-<uid>-1`, `-2`, …) is tried, so the copy is still built once and
    reused — not rebuilt into a throwaway dir on every call, where a Kokoro run
    killed by libi's timeout (SIGKILL: no atexit) would leak it. Only when every
    name is held does it fall back to a private mkdtemp, removed at exit."""
    for n in range(_TMP_NAME_TRIES + 1):
        root = os.path.join(base, f"libi-esd-{uid}" + (f"-{n}" if n else ""))
        if _owned_private_dir(root, uid):
            return root
    fallback = tempfile.mkdtemp(prefix="libi-esd-", dir=base)
    atexit.register(shutil.rmtree, fallback, True)
    return fallback


def short_root(libi_home, platform=None, tmp_base=None, uid=None):
    """The directory the short copy lives in."""
    platform = platform or sys.platform
    if libi_home:
        candidate = os.path.join(os.path.realpath(libi_home), "tts", "esd")
        if _plen(candidate) < SHORT_HOME_MAX:
            os.makedirs(candidate, exist_ok=True)
            return candidate
    if platform == "win32":
        # %TEMP% is per-user (…\AppData\Local\Temp), so no ownership check.
        base = tmp_base or tempfile.gettempdir()
        root = os.path.join(base, "libi-esd")
        os.makedirs(root, exist_ok=True)
        return root
    return _private_tmp_root(
        tmp_base or "/tmp", os.getuid() if uid is None else uid
    )


def _source_files(src):
    for dirpath, _dirs, files in os.walk(src):
        for name in files:
            full = os.path.join(dirpath, name)
            yield os.path.relpath(full, src), os.path.getsize(full)


def _is_current(src, dest):
    try:
        with open(os.path.join(dest, STAMP_NAME), "r", encoding="utf-8") as fh:
            if fh.read() != src:
                return False
        for rel, size in _source_files(src):
            if os.path.getsize(os.path.join(dest, rel)) != size:
                return False
        return True
    except OSError:
        return False


def _build(src, dest):
    """Build a fresh copy beside `dest` and move it into place.

    Safe under parallel Kokoro runs (agents do call generate_speech in
    parallel): every run builds into its OWN unique temp dir and publishes it
    with one atomic rename. When two runs race, the loser finds `dest`
    already current and discards its copy; a stale `dest` is renamed aside
    under a unique name, and a rename that finds it already gone (another run
    moved it first) is not an error.
    """
    root = os.path.dirname(dest)
    tmp = tempfile.mkdtemp(prefix=f"{DATA_DIR_NAME}.tmp-", dir=root)
    try:
        for dirpath, _dirs, files in os.walk(src):
            out_dir = os.path.join(tmp, os.path.relpath(dirpath, src))
            os.makedirs(out_dir, exist_ok=True)
            for name in files:
                s = os.path.join(dirpath, name)
                d = os.path.join(out_dir, name)
                try:
                    os.link(s, d)
                except OSError:
                    shutil.copy2(s, d)
        with open(os.path.join(tmp, STAMP_NAME), "w", encoding="utf-8") as fh:
            fh.write(src)

        for _attempt in range(3):
            try:
                os.rename(tmp, dest)
                return
            except OSError:
                pass
            # `dest` exists. Another run may have just published it — keep theirs.
            if _is_current(src, dest):
                return
            # Stale (a newer espeakng-loader, a half-cleaned /tmp): move it aside.
            aside = f"{dest}.old-{uuid.uuid4().hex[:12]}"
            try:
                os.rename(dest, aside)
            except FileNotFoundError:
                pass  # another run moved it first; try publishing again
            except OSError:
                if _is_current(src, dest):
                    return
                raise
            else:
                shutil.rmtree(aside, ignore_errors=True)
        if _is_current(src, dest):
            return
        raise EspeakPathError(f"could not publish the espeak-ng data copy at {dest}")
    finally:
        # Gone already when the rename published it; otherwise ours to drop.
        shutil.rmtree(tmp, ignore_errors=True)


def short_data_path(src, libi_home, platform=None, tmp_base=None, uid=None):
    """A path to espeak-ng's data that espeak-ng can hold.

    `src` already short enough (once resolved, as phonemizer will) is returned
    as is. Otherwise a hard-link copy is made — idempotently — at
    `<short_root>/espeak-ng-data`. Raises EspeakPathError naming the limit
    when even that is too long.
    """
    real_src = os.path.realpath(src)
    if _plen(real_src) < ESPEAK_PATH_LIMIT:
        return real_src
    root = short_root(libi_home, platform=platform, tmp_base=tmp_base, uid=uid)
    dest = os.path.join(os.path.realpath(root), DATA_DIR_NAME)
    if _plen(dest) >= ESPEAK_PATH_LIMIT:
        raise EspeakPathError(
            f"espeak-ng's data path must be under {ESPEAK_PATH_LIMIT} bytes "
            f"(its path buffer is 160 bytes), and no short location was "
            f"available: {dest} is {_plen(dest)} bytes"
        )
    if not _is_current(real_src, dest):
        _build(real_src, dest)
    return dest
