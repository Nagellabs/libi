<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling (ai-asset-generation flow, fal-ai model ids, libi.upload_file). -->

# Script craft — tone, pacing, and read-aloud timing

Model-agnostic. This is how you write dialogue that sounds like a real person,
not a TTS voice reading ad copy. Use after you've picked an angle
([copywriting-angles.md](copywriting-angles.md)) and a format
([ad-formats.md](ad-formats.md)), before the dialogue gate
([dialogue-gate.md](dialogue-gate.md)).

## Tone bank — pick one persona per video

Choose ONE and carry it through every beat. Each persona is emotion words + a
behavior description you can drop straight into the tone-direction layer.

| Persona | Emotion words | Behavior |
|---|---|---|
| **Excited fan** | genuine, excited, breathless | talks with energy but pauses between thoughts, uses natural breaths, laughs at herself |
| **Chill recommender** | relaxed, honest, conversational | speaks slowly, leaves beats of silence between lines, steady eye contact, shrugs casually |
| **Skeptic converted** | surprised, impressed, almost reluctant | raises eyebrows, pauses mid-sentence as if reconsidering, sounds like they can't believe it |
| **Best friend sharing** | warm, conspiratorial, intimate | lowers their voice, leans in, takes their time — talks like it's a secret worth savoring |
| **Morning routine casual** | sleepy, soft, unhurried | yawns, moves slowly, long pauses between sentences, talks between sips of coffee |

## Mandatory pacing cue

AI video generators default to unnaturally fast speech. **Every tone direction
MUST include an explicit pacing/speed cue** that tells the model to slow down and
leave room. Without it the clip sounds rushed and fake. Pick one (or write your
own in this spirit):

- `pauses between thoughts as if collecting the next word`
- `leaves a beat of silence after each sentence before continuing`
- `speaks at a relaxed, unhurried pace — no rushing`
- `takes natural breaths between sentences, never rushing to the next line`
- `lets moments breathe — a sip, a glance down, a pause before speaking again`

This is not optional. A tone-direction paragraph with no pacing cue is incomplete.

## Read-aloud word count → duration

The word-count→duration methodology, the read-aloud discipline, the silent-beat
rule, and the **"favor one full-length multi-beat clip"** principle live in the
**`ugc-craft`** skill (Clip-duration methodology) — the single source of truth.
Size the WHOLE clip's spoken script (not each beat) to its runtime there. The
[dialogue-gate.md](dialogue-gate.md) enforces the fit check before any spend.

## Dialogue rules

- **Casual spoken language.** Write how people actually talk, not how copy reads.
- **Filler words** make it real: "okay so", "literally", "I'm not even", "like",
  "you guys".
- **End mid-thought or with a laugh**, not a polished sign-off. Real people trail
  off; ad reads land cleanly. You want the former.
- **Each line should feel like a different take** stitched together — slightly
  different framing/energy per beat.
- **No forbidden words** in the spoken line either — see
  [forbidden-words.md](forbidden-words.md). Nobody says "this is a cinematic,
  professional serum" out loud.

A good UGC line is short, specific, and sounds like a voice memo to a friend.
"Okay so I almost returned this and now I'm obsessed" beats "This professional
serum delivers stunning results."
