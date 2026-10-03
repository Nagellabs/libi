---
id: templates-apply-left-out
title: Applying a public template whose apply leaves parts out tells the user what was left out, in libi's neutral words, never the author's values
skills: [templates]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 600
preauthorize: false
covers: [templates, apply_template, cloudId, public-template, leftOut, author-text, neutral-labels]
---

> **What this catches.** A public template is a stranger's, and it can carry style values
> this libi does not have. The apply drops them and lists each in `leftOut`, in libi's own
> words ("layer 1 (text-…): exit effect not available") — and the tool's `leftOutNote` tells
> the agent to pass that on, so the piece differing from the catalog's example video is
> never a silent surprise. The failures: saying nothing, or repeating the AUTHOR's value
> (the unknown effect id, the not-a-colour outline) instead of libi's neutral label.
>
> **The fixture.** `lib/templates/cloud/test-fixture.ts` seeds "Launch title"
> (`lib/templates/cloud/left-out-fixture.ts`), whose headline has an exit effect this libi has never heard
> of and an outline whose colour is not a colour. It is live but NOT LISTED — installable by
> id, absent from the index — so the Public tab's three-card catalog the e2e spec pins is
> unchanged. That is why the prompt names the id rather than asking the agent to search.
>
> **Paraphrase counts.** The author's values are `author-sparkle-burst` (the exit effect)
> and `author-neon-glow` (the outline colour), so any of their words in the agent's own
> text — "glowing", "a burst exit", "sparkly", "Neon" — can only have come from them. The
> needle list is not written here: `{{author-terms:left-out-fixture}}` is expanded by the
> parser from the fixture's own values, verbatim plus every word's stem in three cases
> (`scripts/skill-eval/author-terms.ts`), so the check cannot drift from the fixture. The
> template's name and tags share no word with those values, so quoting the name is safe.
>
> **Why the author-value needles are `agent_text`.** `libi.template` action `get` hands the scaffold
> back (labelled as the author's), so the effect id and the outline value are in the
> transcript on every run, passing or not. Only the agent's own words are evidence of it
> quoting them.

## Prompt
Apply the public catalog template ddddddddddddddddddd5 to a new piece. The headline is
"Launch day".

## Hard invariants
```yaml
assertions:
  - { transcript_contains: '"cloudId":"ddddddddddddddddddd5"', expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_apply_template]", expect: present }
  # The fixture did its job: the apply result listed what it left out.
  - { transcript_contains: "exit effect not available", expect: present }
  # The agent told the user, in plain words…
  - { transcript_contains: ["exit effect", "exit animation", "exit transition"], scope: agent_text, expect: present }
  - { transcript_contains: ["outline", "stroke"], scope: agent_text, expect: present }
  # …and never in the author's — not quoted, and not paraphrased either: the first run
  # (2026-09-24) passed a quote-only needle while telling the user about "the author's
  # neon-glow outline" and "a sparkle burst", read straight off the scaffold's values.
  # Derived from the fixture's author values (see the note above), never hand-listed.
  - { transcript_contains: ["{{author-terms:left-out-fixture}}"], scope: agent_text, expect: absent }
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: absent }
  - { tool: "run_model", expect: absent }
```

## Behavioral expectations
- One `libi.apply_template({ cloudId, newPiece, … })` (the tool installs it first); did
  not rebuild the layer by hand. The headline text went in either as `slotValues` or, since
  `libi.template` action `get` takes no `cloudId` and the slot keys are unknown until the install,
  through `libi.update_overlay` on the slot's layer afterwards — both are fine.
- Told the user, in plain words, that the headline's exit effect and its outline were left
  out because this libi does not have them, so the piece will differ from the template's
  example video there — in the `leftOut` lines' own terms ("layer 1") or the user's word
  for it ("the headline"), as the skill says, never in the author's.
- Did not repeat the author's effect id or outline value, and did not try to recreate the
  missing effect by inventing one.
- Read the template's instructions (`libi.template` action `get`) and ended with `libi.show({ target: "preview" })`
  and one line on what was applied and what is still open.
