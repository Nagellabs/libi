<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling. -->

# Dialogue confirmation gate

A hard gate, separate from cost approval. Before generating any clip that speaks, show the exact words and get an explicit yes: it catches rushed scripts, wrong wording and over-long lines before money is spent. A user who approved the cost, the tone or the template has not approved the words. Run it every time, including a re-roll whose dialogue changed. On a storyboard the words are the card's `voiceover.line`; show the same text.

Show the dialogue as a numbered block with beat labels (`[HOOK]`, `[SHOW]`, `[DEMO]`, `[VERDICT]`, and `(silent beat — …)` for non-spoken beats), then a totals line with the spoken word count, the target duration and the fit check from the word-count method in [craft](../references/craft.md):

```
Here's the dialogue for this clip — confirm before I generate:

  1. [HOOK]    "Okay so I almost returned this."
  2. (silent beat — she tilts the bottle to catch the window light)
  3. [DEMO]    "Two weeks in and my skin is actually calmer."
  4. [VERDICT] "Link's in my bio, you're welcome."

  Spoken words: 19  ·  Target duration: 12 s  ·  Fits at natural pace

Reply "yes" to generate, or tell me what to change.
```

When the count is tight or over for the duration, say so explicitly and offer to shorten, cut filler or lengthen the clip ("31 words is too long for 10 s; I'd cut to about 20 or take 13 s. Which?"); never quietly proceed. A "yes" proceeds (to the cost gate if it is not already cleared); an edit is applied, the whole block re-shown and asked again; a rewrite goes back to [script-craft](script-craft.md) and [copywriting-angles](copywriting-angles.md). A clip with no spoken words still passes through: show the block as all silent beats, say "no spoken dialogue", and confirm.
