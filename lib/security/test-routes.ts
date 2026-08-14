/**
 * RC-B: test/e2e/skill-eval routes are gated behind an explicit opt-in flag,
 * decoupled from `NODE_ENV`.
 *
 * Because `npx libi` runs `next dev` (NODE_ENV !== "production"), any route
 * gated on `NODE_ENV !== "production"` would be LIVE for real users. Those
 * routes (arbitrary MCP tool exec, approval-mode flips) are only ever needed by
 * the skill-eval harness and the e2e runner, which set this flag explicitly on
 * the libi process they spawn. Default OFF.
 */
export function testRoutesEnabled(): boolean {
  return process.env.LIBI_ENABLE_TEST_ROUTES === "1";
}
