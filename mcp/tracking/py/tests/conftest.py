"""Shared fixtures/constants for the tracking pytest suite.

Several tests exercise the tracking pipeline against a real face-tracking
clip. That clip shows an identifiable real person, so it is intentionally
NOT committed to the public repo — it stays on the maintainer's disk and is
gitignored. See __tests__/integration/tracking/fixture-guard.ts for the
mirrored guard used by the vitest suites that share the same fixture.

Tests that need the fixture must skip loudly (not fail) when it is absent,
so a fresh clone's pytest run reports "skipped: <reason>" instead of 15
opaque assertion failures. Import FACE_FIXTURE / FACE_FIXTURE_MISSING_REASON
from here and set a module-level `pytestmark` rather than re-deriving the
path or writing a fresh skipif per file.
"""
import pathlib

# tests -> py -> tracking -> mcp -> <repo root>
REPO_ROOT = pathlib.Path(__file__).resolve().parents[4]
FACE_FIXTURE = REPO_ROOT / "__tests__/fixtures/tracking/non-selfie-face-5s.mp4"
FACE_FIXTURE_MISSING_REASON = (
    f"tracking fixture absent: {FACE_FIXTURE} — this maintainer-only asset "
    "identifies a real person and is not committed to the public repo (see "
    "__tests__/integration/tracking/fixture-guard.ts for the mirrored vitest guard)"
)
