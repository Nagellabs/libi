/**
 * Centralized test-mode detection. Returns true when the user launched libi
 * with `LIBI_TEST_MODE=1 npx libi`. Used by:
 *   - lib/mcp-config.ts to swap fal-ai's transport to the fake-fal stdio
 *     server (mcp/dev/fake-fal/) so the agent uses real fal-ai tool names
 *     but gets deterministic placeholder outputs at zero cost
 *   - mcp/instructions.ts for the TEST MODE banner
 *
 * Read at every call site rather than cached so test code can stub the env
 * via vi.stubEnv() without rebuilding modules.
 */
export function isTestMode(): boolean {
  const v = process.env.LIBI_TEST_MODE;
  return v === "1" || v === "true";
}
