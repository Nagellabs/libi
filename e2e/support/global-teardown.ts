import { restoreNextEnvDts, scheduleScratchCleanup } from "./harness";

/**
 * Both e2e configs' `globalTeardown`: put next-env.d.ts back (`rememberNextEnvDts`),
 * and remove the scratch dirs this run created once its studio has stopped
 * (`scheduleScratchCleanup`), both in ./harness.
 */
export default function globalTeardown(): void {
  restoreNextEnvDts();
  scheduleScratchCleanup();
}
