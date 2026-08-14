<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling (ai-asset-generation flow, fal-ai model ids, libi.upload_file). -->

# Dialogue confirmation gate

A **MANDATORY hard gate**, separate from the cost-approval gate. Before
generating **any** speaking clip, you must show the user the exact spoken
dialogue and get an explicit `yes`. This catches rushed scripts, wrong wording,
and over-long lines *before* spending money on a generation.

**Never assume approval from an earlier gate.** Tone approval, template
approval, and cost approval do NOT cover the dialogue. A user who approved the
cost has not approved the words. Run this gate every time, even on a re-roll if
the dialogue changed.

## What to show

Extract the dialogue from the planned beats as a **numbered block with beat
labels**. Use `[HOOK]` / `[SHOW]` / `[DEMO]` / `[VERDICT]` for spoken beats and
`(silent beat — …)` for non-spoken beats. Then a totals line with the word count
and the natural-pace check from [script-craft.md](script-craft.md), and the
approval prompt.

## Exact display format

```
Here's the dialogue for this clip — confirm before I generate:

  1. [HOOK]    "Okay so I almost returned this."
  2. (silent beat — she tilts the bottle to catch the window light)
  3. [DEMO]    "Two weeks in and my skin is actually calmer."
  4. [VERDICT] "Link's in my bio, you're welcome."

  Spoken words: 19  ·  Target duration: 12s  ·  Fits at natural pace ✅

Reply "yes" to generate, or tell me what to change.
```

### The fits-check

Compute spoken words and compare to the target duration using the
[script-craft.md](script-craft.md) read-aloud table (~2.5 words/sec):

- **✅** — the word count fits the target duration comfortably with pauses.
- **⚠️** — it's tight or over. Say so explicitly and offer to shorten the lines,
  cut filler, or lengthen the clip. Do **not** quietly proceed on a ⚠️.

Example warning line:
```
  Spoken words: 31  ·  Target duration: 10s  ·  ⚠️ too long for 10s —
  I'd cut to ~20 words or bump to 13s. Which do you want?
```

## Accepted responses

- **`yes`** → proceed to generation (then the cost gate if not already cleared).
- **edit** ("change line 3 to…") → apply, re-display the full block, ask again.
- **rewrite** → go back to [script-craft.md](script-craft.md) /
  [copywriting-angles.md](copywriting-angles.md), then re-run this gate.

Silent-only beats with zero spoken words still pass through the gate — show the
block (all `(silent beat — …)`), note "no spoken dialogue", and confirm.
