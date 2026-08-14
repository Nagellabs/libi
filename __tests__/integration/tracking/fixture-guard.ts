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
