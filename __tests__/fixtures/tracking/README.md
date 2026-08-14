# Tracking fixtures

Video fixtures here are **not committed** — they are real footage and stay on the
maintainer's machine (see the ignore rule in `.gitignore`).

The tracking integration tests that need one skip themselves when it is absent,
naming the missing file. A clean clone therefore runs the full suite green with
the tracking end-to-end tests reported as skipped, not failed.

To run them, place a short clip containing a single clearly-visible face at:

    __tests__/fixtures/tracking/non-selfie-face-5s.mp4

Detection thresholds in `face-detection-e2e.test.ts` are tuned to a specific
clip; a different one may need them re-derived.
