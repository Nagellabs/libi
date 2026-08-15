import { existsSync } from "node:fs";
import path from "node:path";

export const FACE_FIXTURE = path.join(
  process.cwd(),
  "__tests__/fixtures/tracking/non-selfie-face-5s.mp4",
);

/** True when the (uncommitted) tracking fixture is present on this machine. */
export const hasFaceFixture = existsSync(FACE_FIXTURE);

export const FIXTURE_SKIP_REASON =
  `tracking fixture absent: ${FACE_FIXTURE} — see that directory's README`;

/**
 * A committed 320×240 / 3s synthetic clip, for tracking tests that need
 * A VIDEO rather than A FACE.
 *
 * Only the detection and end-to-end tracker tests actually require real
 * footage; the track-eval ones drive a hand-built `manual` track and just
 * need pixels to draw boxes over. They used the face fixture anyway, which
 * meant three tests that run anywhere skipped everywhere except this
 * maintainer's machine — the fixture is uncommitted real footage of a real
 * person, so it is absent in CI and in every clone.
 */
export const SYNTHETIC_VIDEO_FIXTURE = path.join(
  process.cwd(),
  "__tests__/helpers/fixtures/video/clip-red-3s.mp4",
);
