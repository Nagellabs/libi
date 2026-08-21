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
 * The heavy face-detection e2e tests are OPT-IN, and deliberately not part of
 * `npm test`.
 *
 * They drive real MediaPipe models through a real Playwright browser against
 * real footage. Under full-suite parallelism that contends for CPU and GPU, and
 * the detector intermittently returns ZERO detections — not a timeout, an
 * outright failure to find anything. It is not a product regression: the same
 * tests pass in isolation, immediately, every time.
 *
 * What made that unacceptable rather than merely annoying: `npm test` is the
 * gate `scripts/release-npm.js` runs before publishing, and these two files
 * failed it twice during the 2026-08-21 release window. Meanwhile they cannot
 * catch anything for anyone else — the fixture is uncommitted real footage of a
 * real person, so they already skip in CI and in every clone. A test that only
 * ever runs on one machine, and there only sometimes, is a release blocker with
 * no compensating coverage.
 *
 * They are NOT deleted, because they do catch real detection regressions when
 * run deliberately. Run them with:
 *
 *     LIBI_TEST_TRACKING_E2E=1 npm test -- __tests__/integration/tracking
 *
 * And note AGENTS.md's standing rule: the acceptable evidence for a tracking
 * change is rendered pixels on real footage
 * (`npm run track:eval -- --via-product-render --assert`), which is a stronger
 * check than either of these and is unaffected by this gate.
 */
export const trackingE2eEnabled = process.env.LIBI_TEST_TRACKING_E2E === "1";

/** Run only when the fixture exists AND the opt-in is set. */
export const runTrackingE2e = hasFaceFixture && trackingE2eEnabled;

export const TRACKING_E2E_SKIP_REASON = !hasFaceFixture
  ? FIXTURE_SKIP_REASON
  : "tracking e2e is opt-in — set LIBI_TEST_TRACKING_E2E=1 to run it";

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
