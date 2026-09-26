/**
 * The test-mode catalog's "left-out" seed, as plain constants.
 *
 * Kept in a module with NO imports because two very different consumers read it: the
 * fixture catalog (`test-fixture.ts`, which seeds it) and the skill-eval scenario parser
 * (`scripts/skill-eval/author-terms.ts`, which derives `templates/06`'s forbidden
 * paraphrase terms from the author values). Nothing under `scripts/skill-eval/` may pull
 * in `@/lib/logger` — it opens `<LIBI_HOME>/logs/libi.log` at import — so the parser
 * cannot import `test-fixture.ts` itself.
 *
 * The NAME and TAGS share no word with the author values, on purpose: the agent may say
 * the template's name freely, so a word in both would blind the paraphrase check. The
 * first version was called "Glow title" beside an outline value `author-neon-glow`, and
 * "glow" had to be left out of the check.
 */
export const FIXTURE_LEFT_OUT_CLOUD_ID = "ddddddddddddddddddd5";
export const FIXTURE_LEFT_OUT_NAME = "Launch title";
export const FIXTURE_LEFT_OUT_TAGS: readonly string[] = ["title", "launch"];
/** The author's own values in the left-out seed — what the agent must never repeat to the user. */
export const FIXTURE_LEFT_OUT_AUTHOR_VALUES = { exitEffectId: "author-sparkle-burst", outlineColour: "author-neon-glow" } as const;
