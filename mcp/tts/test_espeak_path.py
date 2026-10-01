# mcp/tts/test_espeak_path.py
"""pytest for espeak_path.py (stdlib only — no kokoro needed).

  uv run --with pytest python -m pytest mcp/tts/test_espeak_path.py

Run by __tests__/integration/tts-synthesize-e2e.test.ts (LIBI_TTS_E2E=1).
"""
import os
import shutil
import sys
import tempfile
import threading

import pytest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import espeak_path  # noqa: E402
from espeak_path import (  # noqa: E402
    ESPEAK_PATH_LIMIT,
    EspeakPathError,
    short_data_path,
)


def make_data_dir(base, length):
    """An espeak-ng-data lookalike whose real path is exactly `length` chars."""
    base = os.path.realpath(base)
    tail = os.sep + "espeak-ng-data"
    pad = length - len(base) - len(tail) - 1
    assert pad > 0, "tmp base too long for the requested length"
    parts = []
    while pad > 0:
        n = min(pad, 60)
        parts.append("p" * n)
        pad -= n + 1  # the separator before the next part
    if pad < 0:  # the last separator overshot by one: trim the last part
        parts[-1] = parts[-1][:-1] if len(parts[-1]) > 1 else parts[-1]
    src = os.path.join(base, *parts) + tail
    # nudge to the exact length
    while len(src) < length:
        parts[-1] += "p"
        src = os.path.join(base, *parts) + tail
    while len(src) > length:
        parts[-1] = parts[-1][:-1]
        src = os.path.join(base, *parts) + tail
    os.makedirs(os.path.join(src, "voices", "!v"))
    with open(os.path.join(src, "phontab"), "wb") as fh:
        fh.write(b"phontab-bytes")
    with open(os.path.join(src, "voices", "!v", "f1"), "wb") as fh:
        fh.write(b"variant")
    return src


@pytest.fixture
def short_home():
    # pytest's tmp_path is ~100 characters on macOS — too long to exercise the
    # <LIBI_HOME>/tts/esd branch — so the home goes under /tmp on POSIX.
    d = tempfile.mkdtemp(prefix="esd-t-", dir=None if sys.platform == "win32" else "/tmp")
    yield os.path.join(d, "h")
    shutil.rmtree(d, ignore_errors=True)


def test_a_214_char_path_gets_a_short_hard_link_copy(tmp_path, short_home):
    src = make_data_dir(str(tmp_path / "cache"), 214)
    assert len(src) == 214
    home = short_home
    assert len(os.path.join(os.path.realpath(home), "tts", "esd")) < espeak_path.SHORT_HOME_MAX

    out = short_data_path(src, home)

    assert len(out) < 100
    assert out == os.path.join(os.path.realpath(home), "tts", "esd", "espeak-ng-data")
    # Points at the same data: the SAME file (a hard link), not a lookalike.
    assert os.path.samefile(os.path.join(out, "phontab"), os.path.join(src, "phontab"))
    with open(os.path.join(out, "voices", "!v", "f1"), "rb") as fh:
        assert fh.read() == b"variant"
    # No symlink anywhere: phonemizer resolve()s the path it is given, and a
    # symlink resolves straight back to the long one.
    assert not os.path.islink(out)
    assert os.path.realpath(out) == out


def test_idempotent(tmp_path):
    src = make_data_dir(str(tmp_path / "cache"), 214)
    home = str(tmp_path / "h")
    out1 = short_data_path(src, home, tmp_base=str(tmp_path))
    ino = os.stat(os.path.join(out1, ".libi-source")).st_ino
    out2 = short_data_path(src, home, tmp_base=str(tmp_path))
    assert out1 == out2
    assert os.stat(os.path.join(out2, ".libi-source")).st_ino == ino


def test_a_stale_copy_is_rebuilt(tmp_path):
    src = make_data_dir(str(tmp_path / "cache"), 214)
    home = str(tmp_path / "h")
    out = short_data_path(src, home, tmp_base=str(tmp_path))
    os.remove(os.path.join(out, "voices", "!v", "f1"))  # a half-cleaned /tmp
    out2 = short_data_path(src, home, tmp_base=str(tmp_path))
    assert os.path.isfile(os.path.join(out2, "voices", "!v", "f1"))
    assert not [n for n in os.listdir(os.path.dirname(out2)) if ".tmp-" in n or ".old-" in n]


def test_a_short_path_is_used_as_is(short_home):
    # Beside the short home: pytest's tmp_path grows with each session number
    # and can itself approach the limit.
    base = os.path.join(os.path.dirname(short_home), "c")
    src = make_data_dir(base, len(os.path.realpath(base)) + 40)
    assert len(os.fsencode(src)) < ESPEAK_PATH_LIMIT
    assert short_data_path(src, short_home) == os.path.realpath(src)
    assert not os.path.exists(os.path.join(short_home, "tts"))


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX ownership branch")
def test_a_long_home_falls_back_to_a_private_tmp_dir(tmp_path):
    src = make_data_dir(str(tmp_path / "cache"), 214)
    long_home = str(tmp_path / ("h" * 120))
    out = short_data_path(src, long_home, platform="linux", tmp_base=str(tmp_path))
    root = os.path.dirname(out)
    assert os.path.basename(root) == f"libi-esd-{os.getuid()}"
    assert (os.stat(root).st_mode & 0o777) == 0o700


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX ownership branch")
def test_a_tmp_dir_others_can_write_is_not_used(tmp_path):
    src = make_data_dir(str(tmp_path / "cache"), 214)
    squat = tmp_path / f"libi-esd-{os.getuid()}"
    squat.mkdir()
    os.chmod(squat, 0o777)
    out = short_data_path(src, None, platform="linux", tmp_base=str(tmp_path))
    assert not out.startswith(os.path.realpath(str(squat)) + os.sep)
    assert os.path.isfile(os.path.join(out, "phontab"))
    # A STABLE next name, reused — not a throwaway copy per call that a
    # SIGKILLed run would leak (review M-6).
    assert os.path.basename(os.path.dirname(out)) == f"libi-esd-{os.getuid()}-1"
    ino = os.stat(os.path.join(out, ".libi-source")).st_ino
    again = short_data_path(src, None, platform="linux", tmp_base=str(tmp_path))
    assert again == out
    assert os.stat(os.path.join(again, ".libi-source")).st_ino == ino


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX ownership branch")
def test_a_symlink_at_the_tmp_name_is_not_used(tmp_path):
    src = make_data_dir(str(tmp_path / "cache"), 214)
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir(mode=0o700)
    os.symlink(str(elsewhere), str(tmp_path / f"libi-esd-{os.getuid()}"))
    out = short_data_path(src, None, platform="linux", tmp_base=str(tmp_path))
    assert not out.startswith(os.path.realpath(str(elsewhere)) + os.sep)


def test_windows_uses_a_per_user_temp_dir(tmp_path):
    src = make_data_dir(str(tmp_path / "cache"), 214)
    out = short_data_path(src, None, platform="win32", tmp_base=str(tmp_path))
    assert out == os.path.join(os.path.realpath(str(tmp_path)), "libi-esd", "espeak-ng-data")


def test_too_long_even_when_short_names_the_limit(tmp_path):
    src = make_data_dir(str(tmp_path / "cache"), 214)
    deep = tmp_path / ("d" * 60) / ("d" * 60)
    deep.mkdir(parents=True)
    with pytest.raises(EspeakPathError, match=str(ESPEAK_PATH_LIMIT)):
        short_data_path(src, None, platform="win32", tmp_base=str(deep))


def make_data_dir_bytes(base, n_bytes, char):
    """A data dir whose real path is exactly `n_bytes` UTF-8 bytes, padded with
    a multi-byte `char`, so it has far fewer characters than bytes."""
    base = os.path.realpath(base)
    tail = os.sep + "espeak-ng-data"
    fixed = len(os.fsencode(base)) + 1 + len(os.fsencode(tail))
    width = len(char.encode("utf-8"))
    n_chars, rest = divmod(n_bytes - fixed, width)
    src = os.path.join(base, char * n_chars + "a" * rest) + tail
    assert len(os.fsencode(src)) == n_bytes
    os.makedirs(src)
    with open(os.path.join(src, "phontab"), "wb") as fh:
        fh.write(b"phontab-bytes")
    return src


def test_the_limit_is_bytes_not_characters(tmp_path, short_home):
    # Under 159 characters, over 159 bytes: espeak-ng would truncate it.
    # Next to the short home: pytest's tmp_path alone is ~100 characters.
    base = os.path.join(os.path.dirname(short_home), "c")
    os.makedirs(base)
    src = make_data_dir_bytes(base, 200, "\u4e2d")  # 3 bytes in UTF-8
    assert len(os.path.realpath(src)) < ESPEAK_PATH_LIMIT
    out = short_data_path(src, short_home)
    assert out != os.path.realpath(src)
    assert len(os.fsencode(out)) < 100
    assert os.path.samefile(os.path.join(out, "phontab"), os.path.join(src, "phontab"))


def test_parallel_runs_on_a_stale_copy_all_succeed(tmp_path, short_home):
    # Review M-3: agents call generate_speech in parallel, and after an
    # espeakng-loader bump every run sees the old copy as stale at once.
    src = make_data_dir(str(tmp_path / "cache"), 214)
    old_src = make_data_dir(str(tmp_path / "old"), 214)
    first = short_data_path(old_src, short_home)  # the copy of the old version

    n = 8
    barrier = threading.Barrier(n)
    results, errors = [], []

    def run():
        barrier.wait()
        try:
            results.append(short_data_path(src, short_home))
        except Exception as e:  # noqa: BLE001
            errors.append(e)

    threads = [threading.Thread(target=run) for _ in range(n)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert errors == []
    assert set(results) == {first}
    with open(os.path.join(first, ".libi-source"), encoding="utf-8") as fh:
        assert fh.read() == os.path.realpath(src)
    assert os.path.samefile(os.path.join(first, "phontab"), os.path.join(src, "phontab"))
    leftovers = [e for e in os.listdir(os.path.dirname(first)) if ".tmp-" in e or ".old-" in e]
    assert leftovers == []
