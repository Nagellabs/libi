---
id: templates-01-create-from-piece
title: '"Make a template from this piece" captures it, writes index.md, asks private-or-public and waits before showing the page'
skills: [templates]
mcps: []
agent: claude-code
runs: 1
timeoutSec: 600
preauthorize: false
covers: [templates, create_template_from_piece, index-md, private-or-public]
---

> **What this catches.** The create flow's three failure modes: skipping the one-message
> intake (name / description / tags / slots), calling the tool and never writing `index.md`,
> and never asking private-vs-public. The piece is empty when the prompt arrives, so the agent
> first has to build something to capture — one text overlay is enough and keeps the run cheap.
>
> **The prompt must NOT settle private-vs-public.** The first run (2026-09-23) said "Keep it
> private." and the agent reasoned that the question was already answered and skipped it — so
> the verbatim-question matcher failed on a prompt that made asking redundant. Leaving the choice
> open is what makes the skill's "Always ask" the behaviour under test.
>
> **`preauthorize: false`, and a needle without "this template".** Under the default preamble
> ("no human is available to answer questions") the second run reasoned that nobody could
> answer, skipped the question and only paraphrased it in its summary. The no-spend preamble
> says stopping at a skill's question is correct, and with it the agent asked — but named the
> template ("keep \"Sale card\" private on this machine, or publish it to the public catalog
> …"), so the needle is the part of the skill's sentence that survives that substitution.
>
> **The question must come BEFORE `libi.show_templates`, so in a one-turn run the page is never
> shown.** `show_templates` takes the user to the Templates page, which has no chat; Task 13's
> walk-through and runs 3–4 of this scenario showed the page first and asked afterwards, so the
> question landed where nobody could see it. The skill now says ask, end the turn, and show the
> page only after the answer. This harness cannot answer, so the correct run asks and stops:
> `show_templates` present is the regression, and its absence alongside the question is the
> ordering assertion.
>
> **No export for the preview (skill 1.21.1).** `create_template_from_piece` now starts the
> template's preview render by itself (the `template_example` job). An agent that doesn't know
> exports the piece to "make a preview" — a wasted render the user never asked for, so
> `libi.export_video` present is the regression.

## Prompt
Add a text overlay that says "Summer sale" in the middle of the frame for 3 seconds. Then make a
template from this piece. Call it "Sale card", describe it as "a centred sale headline", tag it
promo and sale, and make the headline a required text slot called headline.

## Hard invariants
```yaml
assertions:
  - { transcript_contains: "[tool-call mcp__libi__libi_add_overlay]", expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_create_template_from_piece]", expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_show_templates]", expect: absent }
  - { transcript_contains: '"slots"', expect: present }
  - { transcript_contains: "private on this machine, or publish it to the public catalog", expect: present }
  - { transcript_contains: "[tool-call mcp__libi__libi_export_video]", expect: absent }
  - { tool: "run_model", expect: absent }
  - { tool: "submit_job", expect: absent }
```

## Behavioral expectations
- Added the text overlay, then called `libi.create_template_from_piece` with `name: "Sale card"`,
  the description, `tags: ["promo", "sale"]` and one slot `{ key: "headline", kind: "text",
  required: true, fromOverlayKey: <the overlay's id or key> }` — all from the prompt, without a
  second round of questions.
- Wrote the `index.md` at the returned `instructionsPath` (a file edit of that exact path),
  replacing the `<…>` placeholders under Purpose / Slots / Steps / Style rules / Do not change.
- Asked the skill's private-or-public question (naming the template in place of "this template"
  is fine) and did NOT claim anything was published (the
  template is saved locally either way; with nobody to answer, it stays private).
- Ended the turn on that question: did NOT call `libi.show_templates` (it comes only after the
  user's answer) and asked nothing after it.
- Did NOT export the piece or otherwise make a preview: the tool renders the template's preview
  by itself (saying so to the user is welcome, not required).
