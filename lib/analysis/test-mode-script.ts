/**
 * Deterministic placeholder `Script` JSON for `LIBI_TEST_MODE=1`.
 *
 * Why this exists (dogfood finding F6): the provider-driven script analysis
 * (`libi.extra_analysis_model`) talks to fal **directly** via
 * `lib/analysis/script-providers/fal-video-understanding.ts` — it does NOT go
 * through the `fal-ai` MCP that test mode swaps for fake-fal. Without a gate it
 * therefore runs a REAL paid fal video-understanding job during "test mode",
 * silently violating the `$0 actual spend` guarantee (the agent + TEST MODE
 * banner both believe it's free).
 *
 * The runner short-circuits to this placeholder when {@link isTestMode} is true,
 * so the full pipeline + persistence are exercised at zero cost with no network
 * call. The text is a valid `script_v1` document (passes `scriptSchema` via
 * `parseAndValidateScript`) and is clearly marked as a placeholder so nothing
 * downstream mistakes it for a real analysis.
 */
export function buildTestModePlaceholderScriptText(durationSeconds: number): string {
  const dur =
    Number.isFinite(durationSeconds) && durationSeconds > 0 ? durationSeconds : 10;
  const half = Math.round((dur / 2) * 1000) / 1000;

  // `provider` is intentionally omitted — `parseAndValidateScript` overwrites it
  // from the runner-supplied metadata (it never trusts model-authored provider).
  const script = {
    schema_version: "script_v1",
    duration: dur,
    overall_style:
      "TEST MODE placeholder script (LIBI_TEST_MODE=1). No script provider was called and no credits were spent. Run libi without test mode to generate a real analysis.",
    pacing: "placeholder",
    shots: [
      {
        index: 0,
        start: 0,
        end: half,
        description:
          "Placeholder shot 1 — test mode did not analyze the source video.",
      },
      {
        index: 1,
        start: half,
        end: dur,
        description:
          "Placeholder shot 2 — test mode did not analyze the source video.",
      },
    ],
    music: { present: false },
    dialogue_summary:
      "Placeholder — test mode did not analyze the source audio.",
    custom: { testModePlaceholder: true },
  };

  return JSON.stringify(script);
}
