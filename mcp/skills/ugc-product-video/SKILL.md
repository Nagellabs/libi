---
name: ugc-product-video
description: Walks the user through creating a UGC-style AI product video — brief, ad format + production route, character + product references, a real scripted ad, per-clip generation on Seedance 2.0 (default), validation, audio, captions, end card. Thin router over the prompt files in `prompts/`. Use when the user wants to create a product ad, demo video, or social UGC. Default to ONE full-length multi-beat clip (15s with in-prompt jump-cut beats), not one short clip per beat.
when_to_use: Triggers on "make a UGC video", "create a product ad", "TikTok-style video", "demo video for my product", or any request to film a person showing or using a product.
tags:
  - ugc
  - generation
---

# UGC Product Video

This skill is a **thin router**. It owns the stage order and the hard gates; all
deep craft (brief questions, ad-format beat frameworks, script tone + pacing,
copywriting angles, the per-model prompt formulas, the footage-route flows) lives
in the prompt files under `prompts/`. Move through the stages in order. Hit every
gate before you spend credits.

When you call generation tools, do it via the **`ai-asset-generation`** skill —
never call provider tools directly. When you stitch clips or extract frames, use
Libi's ffmpeg tools (`libi.concat_videos`, `libi.generate_thumbnails`).

## The Storyboard is the build spine (default — not optional)

You build the ad **through the Storyboard**. It is NOT a planning step you can swap for an
ad-hoc generate loop — it *is* how a UGC ad is built, and it is the default for **every** ad
(including a single-clip one). Invoke **`using-storyboard`** and follow it; the brief,
references, beats, and gates this skill produces all feed into it. The Stage map below is the
UGC *craft + gates*; the Storyboard is the *mechanism* that realizes it.

**Card = a generated clip = a timeline scene. A beat is a jump-cut INSIDE a card.** This one
mapping keeps the "don't fragment the ad" rule intact while putting everything on the board:
- A single multi-beat 15s ad is **ONE card** — its schematic is the beat strip, its prompt
  carries the in-prompt jump-cuts. Do **NOT** make one card per beat.
- An **extend chain** is **ONE card** — the extend versions are the card's *takes*, the final
  extend is the selected take, and a rollback is just selecting a prior take.
- A **stitch** (source + AI, or multi-clip) is **N cards** — a reused beat is a card whose
  take is the trimmed source file; an AI beat is a card whose take is generated. Use a live
  `reference_video` link between consecutive cards (`set_storyboard_reference`) for continuity.

**How each card is built:** author its schematic (free blocking review — character + product +
camera) → author its generation spec (the Stage 1 character reference is the keyframe on EVERY
card; the clip is produced by the path's craft in [production-routes](prompts/production-routes.md))
→ `libi.show_storyboard` → get the user's schematic approval (the free pre-spend gate) →
generate the take → validate it (Stage 4.5) → `libi.select_storyboard_take` to place it as the
scene. Because select-take places the scene, the timeline fills in front of the user as each
card validates — the "empty piece" rule (Stage 4.5) is satisfied automatically.

**Opt-off is a rare, explicit user exception.** ONLY if the user directly says "skip the
storyboard / just generate" do you drop to direct generation and place clips with
`libi.add_overlay({ kind: "video" })`. It is never your default and never something you offer proactively.
Either way, the hard cost / dialogue / validation / audio gates still apply.

## Recommended model (maintainer-updated 2026-05-30)

```
RECOMMENDED_VIDEO_MODEL = bytedance/seedance-2.0
Rationale: strongest 2026 UGC physics + native audio + image/end-image FLF.
This is the one line you edit when you fork this skill to change your default.
```

> The value above is the model **family** — when generating, call the suffixed endpoint `bytedance/seedance-2.0/image-to-video` (default) or `bytedance/seedance-2.0/reference-to-video`; passing the bare id (no operation suffix) to run_model/submit_job 404s on fal.

## Model-selection policy

For **any** UGC video, SUGGEST Seedance 2.0 first, with a one-line why ("strongest
2026 UGC physics + native audio + image/end-image first-last-frame control"). It
is the default, not a mandate.

- **Honor explicit per-project overrides.** If the user says "use Kling this time"
  or "do this one on Veo", do exactly what they ask for that project — don't
  re-pitch Seedance. A one-off override is not a standing preference (see the fork
  section below for standing preferences).
- **Always verify the chosen model at runtime.** NEVER trust the hardcoded id
  above as ground truth — model availability, schemas, and pricing drift. Before
  generating, confirm via the fal tools: `recommend_model` (sanity-check the pick),
  `get_model_schema` (confirm inputs/FLF support), `get_pricing` (disclose cost).
- **Route to the matching model guide + use-case formula** once the model is chosen:
  - Load the engine's prompting guide from the **`ai-video-models`** skill —
    Seedance 2.0 → `model-seedance-2`, Veo 3.1 → `model-veo-3-1`, Kling → `model-kling`.
  - Then load the matching UGC use-case formula from THIS skill's prompts (selected via
    [ad-formats](prompts/ad-formats.md)): [ugc](prompts/model-seedance-2-ugc.md) ·
    [product-hero](prompts/model-seedance-2-product-hero.md) ·
    [feature-walkthrough](prompts/model-seedance-2-feature-walkthrough.md) ·
    [premium-reveal](prompts/model-seedance-2-premium-reveal.md) ·
    [studio-lookbook](prompts/model-seedance-2-studio-lookbook.md).

## Permanent-override (fork) instruction

When the user states a **standing** preference ("always use X", "make Y my default", "I never want
Seedance"), do NOT just comply for this one project — offer forking: *"I can make that your permanent
default by creating your own editable copy of this skill with the recommended model changed; it'll
apply to every future UGC video (or I can write a fresh skill, or adapt one you found online)."* If
they take it: drive `libi.fork_skill` on this skill's id, then edit the `RECOMMENDED_VIDEO_MODEL` line
in the user copy (name-keyed lookups resolve the **user** row). Reverting = delete the user copy
(re-tracks the bundled default).

## Load the `ugc-craft` skill first

Before composing ANY prompt, load the **`ugc-craft`** skill — it owns the UGC
craft (the 9-layer formula, the clip-duration methodology, pacing / natural-motion
/ skin-realism cue banks, character-consistency phrasing, the negative-prompt +
forbidden-word lists). The model files under `prompts/` carry only the
model-specific caps and params; the *craft* lives in `ugc-craft`. Do not
re-derive it from memory.

Load the **`voiceover-production`** skill before deciding any audio/voice: it owns
native-audio + the `reference-to-video` voice carry. Changing the voice on a finished
video is the separate, user-triggered **`voice-replacement`** skill — not generation.

Load the **`video-planning`** skill before authoring the beat sheet: it owns the
senior-editor decomposition (building blocks, source-vs-AI, combine-vs-split, style
inheritance) that the beat sheet in Stage 0 should express. Plan the ad into blocks
first, then build those blocks as cards.

## Mandatory rule — read the prompt file before composing

**Never wing a prompt from memory.** Before composing ANY prompt, load the chosen engine's guide
from **`ai-video-models`** (`model-seedance-2` / `model-veo-3-1` / `model-kling`), the matching UGC
use-case formula from this skill's `prompts/`, the [ad-formats](prompts/ad-formats.md) formula, and
the banned-token list ([forbidden-words](prompts/forbidden-words.md)) — they carry the prompt order,
motion specificity, and consistency anchors that keep the output on-model.

## Stage map

**Stage 0 — Frame the project.** Run the brief intake
([brief-intake](prompts/brief-intake.md)) — the six questions that turn a slideshow
of test shots into an actual ad. Pick an **ad format** ([ad-formats](prompts/ad-formats.md))
and, if a source video exists, a **production route** ([production-routes](prompts/production-routes.md)).
Reference [platform-specs](prompts/platform-specs.md) for target aspect ratio and
safe-zones. **Decompose the ad into building blocks via `video-planning`** (each block's
content, source-vs-AI, combine-vs-split, and style inheritance) — that block plan IS the
beat sheet. Record the chosen settings (format, route, model, approval mode/cap,
voice/script-analysis opt-ins) on the piece — put the short human-facing summary in
the piece **description** (capped at 500 chars), and keep the durable beat sheet (the
block plan) + handoff notes in the storyboard **overview** (set via
`libi.add_storyboard_card({ overview })`).

**Stage 0.5 / 0.6 — Source analysis (MIMIC route only).** Only when a source video
exists. **Invoke the `video-analysis` skill** to analyze the source — it owns the whole
flow (keyframe density, the per-frame vision pass, transcript, structured summary, and
the optional paid full-video script pass). Don't re-implement analysis here. Your
UGC-specific job is to read its output for what you need to *mimic*: the beat structure
and timing, the spoken hook + pacing, the presenter's look/energy, the product moments,
and the shot grammar (framing, lighting, cuts). The paid full-video script pass adds
per-shot camera/lighting/mood + audio/music descriptors — worth surfacing (with its cost)
for the stitch route and from-scratch-with-source, where threading those descriptors into
Stage 4 prompts tightens the match. See [production-routes](prompts/production-routes.md)
for the per-route reuse plan. **For a STITCH you MUST `Skill`-launch `stitching-multi-clip` BEFORE
the intake/script** — it owns the partition, the no-reusable-section gate, the voice always-ask, AND
the physical-continuity gate (the new character must match the reused body parts). Don't plan it here.

**Stage 1 — Character.** Ask who's in the video (demographics, look, energy).
Delegate to `realistic-image-generation` (the gpt-image-2 realism picker) to
produce 1–3 candidate portrait references — front-facing, neutral-lit, clean
background. Save the pick as the character reference. **STITCH: the character is constrained
by the reused footage — match its visible body parts (skin tone non-negotiable, age, build)
per `stitching-multi-clip`'s continuity gate.** **Approval gate** before moving on.

**Stage 2 — Product.** Ask the user to upload product references
(`libi.upload_file`). **Read the pixels** — vision-Read each reference image and
write a structured summary (name, category, color/finish, key features, packaging,
distinguishing details). If they only described the product, generate references
via `ai-asset-generation` FIRST, then read those. Confirm the summary with the user
before continuing.

**Stage 3 — Script.** Write a GOOD ad first; feasibility comes second. Flow:
[brief-intake](prompts/brief-intake.md) → the beat framework for the chosen format
([ad-formats](prompts/ad-formats.md), including the ≥1 silent-action-beat rule) →
[script-craft](prompts/script-craft.md) (tone bank, mandatory pacing cue,
read-aloud word-count→duration timing) → [copywriting-angles](prompts/copywriting-angles.md)
(generate genuinely different hook variants for A/B). Then run the
[dialogue-gate](prompts/dialogue-gate.md). **Approval gate** — the user edits the
beats inline before any generation.

**Stage 4 — Generation.** Each clip you generate here is a Storyboard **card's take** —
[production-routes](prompts/production-routes.md) tells you HOW to produce it; you then
`libi.attach_storyboard_clip` it to its card and `libi.select_storyboard_take` after Stage 4.5
passes (see "The Storyboard is the build spine" above for the card↔clip↔beat mapping). Dispatched
by the production route and the chosen model's prompting guide
(loaded from the `ai-video-models` skill) plus the matching use-case formula. **No in-video
text** on any path — every prompt carries the no-text rule from `ai-asset-generation`
**Step 6.6**; text the script needs is added in Stage 7, never baked in. Physical-
manipulation beats (applying / peeling / pressing / pouring) follow the
`physical-action-video` FLF ladder and are isolated from any continuous
extend chain — `production-routes` carries the full isolation rule. On the default Seedance path, generate the whole ad as ONE multi-beat clip (beats = in-prompt jump cuts); use separate per-beat clips ONLY when the chosen model can't do multi-beat or a beat hits the editorial fallback. Do NOT fragment a 15s ad into four 3–4s clips.

**Stage 4.5 — Validate every clip (HARD GATE — inline below).**

**Stage 5 — Build to target length.** **Default to ONE full-length multi-beat
clip** — favor the longest single clip the chosen model can produce (a native
multi-beat model like Seedance renders the jump-cut beats inside one ≤15s prompt;
an extend-capable model chains to length as one unified clip). Only stitch
multiple SEPARATE clips when the script exceeds the model's single-clip max, hits
36+ spoken words, or a manipulation beat falls back to the editorial split. Do
NOT fragment the ad into many 3–4s clips. See `ugc-craft` (duration methodology)
and [production-routes](prompts/production-routes.md) Stage 5.

**Stage 6 — Audio (path-aware).** Every route keeps its **native audio**
(`generate_audio = true`) by default — fully-AI clips speak their native voice; a Path C
stitch keeps the source voice / `@Audio1` carry. Never mute to lay a separate VO during
generation; a DIFFERENT voice on the finished video is the user-triggered
**`voice-replacement`** skill. Policy: [production-routes](prompts/production-routes.md) Stage 6.

**Stage 7 — Captions + end card.** Text comes from `libi.add_overlay({ kind: "text" })` (captions,
lower-thirds, CTA), end-card title from `libi.add_overlay({ kind: "image" })`. **Text is single-line and
does NOT wrap — size each caption to the canvas `width`** (`maxChars ≈ 0.84×width/(0.6×fontPx)`;
split long lines, never overflow — see `speech-captions` `prompts/readability.md`). Add a
product-name lower-third on the first reveal beat; build a 2s canvas end-card holder if none.

**Stage 8 — Verify-before-commit (HARD GATE — inline below).**

**Stage 9 — Lessons capture.** Append a structured "lessons" note to the piece
(storyboard **overview** / description): what worked, which model + prompt patterns
produced the best beats, what to avoid next time. Future runs reference it.

---

## Stage 4.5 — Validate every clip (REQUIRED gate)

**For the extend-chain route:** validate ONLY the final (latest) extend output — the
intermediate versions are rollback points, not on the timeline. **For every other
route:** validate every saved clip (each maps to a timeline scene). REUSE beats
(trimmed source) skip this gate — source footage is already validated.

Every AI-generated clip MUST pass this before it counts as part of the piece — and the
validation must produce a REAL analysis record, not a note claiming a pass. Skipping it,
or faking it, is a skill bug.

**Run the validation through the `video-analysis` skill** — invoke it on the clip and let
it own the mechanics (extract a few keyframes → look at the actual pixels → persist a
frame/summary analysis record). Don't re-implement that flow here. A short clip only needs
a handful of frames.

Your UGC-specific responsibility is the **grading**. When you look at each frame, score it
for the AI-generation failure modes — be specific, say "none" if clean:
- extra / missing fingers, malformed hands;
- illegible text masquerading as real words;
- broken physics (gravity, motion continuity, inter-frame jumps);
- off-model character drift vs the Stage 1 reference.

Record your findings **and an overall severity** in the saved analysis so the record is
durable, and append that severity to the file's notes lineage. Derive severity: any
extra-fingers or fake-text finding = `reject`; minor blur / palette drift = `minor`;
otherwise `ok`. Then branch:
- **`ok`** — attach the clip to its card as a take (`libi.attach_storyboard_clip`) and
  `libi.select_storyboard_take` to place the scene NOW, so the preview builds up in front of the
  user. (Opt-off direct-generation run only: `libi.add_overlay({ kind: "video" })` instead.)
- **`minor`** — tell the user the issues, ask keep-or-regen (default keep). **The moment it's
  kept, attach + select the take NOW, exactly as for `ok`** — do not wait. A `minor` grade is the
  common case for real generation; if placement only happened on a perfect `ok`, the piece would
  sit visibly EMPTY through the whole multi-minute generation and only get scenes in a final batch
  assembly. That's the bug to avoid.
- **`reject`** — tell the user the issues; regen with a prompt patch targeting the specific
  failure (e.g. "anatomically-correct hands, five fingers"; "no on-screen text"), bump the retry
  counter, fire again. Attach each regen as a NEW take on the same card so the versions are kept;
  select the good one. Each retry counts against the batch cap.

**Incremental build is REQUIRED, not optional (the "empty piece" rule).** Every clip that is
KEPT (whether graded `ok` or `minor`-kept) is **selected onto its card immediately after it
validates** (`libi.select_storyboard_take` — `libi.add_overlay({ kind: "video" })` only on an opt-off direct
run) — never batch all placement to the end. The piece must build up visibly as each clip lands:
after card 1's take is selected the timeline shows 1 scene, after card 2 it shows 2, and so on.
Leaving generated-and-kept clips as unselected takes (or loose files) while the composition stays
empty is a defect — the user sees a piece with no video even though clips exist. By Stage 8 every
kept clip MUST already be a scene on the timeline (Stage 8 verifies the scene shape; it does not
place the takes for you).

**Video-understanding pass (for physical-manipulation beats).** For any clip whose beat
manipulates a product (applying / peeling / pressing / pouring), also run the
`physical-action-video` video-understanding check — a YES/NO/UNCLEAR pass on the six
universal physical-plausibility questions plus 2–4 beat-specific ones. All YES → accept;
1–2 UNCLEAR → accept-with-notes; 3+ UNCLEAR or any NO → regenerate targeting the failing
question.

**The commit gate backs this up.** When you commit the draft, libi hard-refuses (error
`unvalidated_generated_clips`) any commit where an AI-generated clip on the timeline lacks a
completed analysis record — a claim in a note is not a substitute. So a skipped or faked
validation surfaces at commit time; validate the offending clips, then retry.

---

## Stage 8 — Verify-before-commit gate (REQUIRED)

Before you commit the draft, verify the composition actually matches the route's plan.
This catches "I claimed I added the VO but didn't" bugs.

> **HARD RULE — not optional, not skippable.** Do NOT commit unless you have just read
> the composition back (with the composition-read tool) in the same turn and walked the
> checks below. The server commit gate only enforces *clip validation* — it does NOT
> catch audio-shape, scene-count, or overlay mismatches, so those are entirely on you.
> (Observed QA failure, 2026-05-30: a stitch shipped with the source audio still playing
> under the VO because this step was skipped.)

Read the composition back, then confirm — against the route you actually ran:

1. **Audio shape.** Does the audio match the route's policy (the per-route table in
   [production-routes](prompts/production-routes.md) Stage 6)? The critical stitch-route
   check: **no source/inline audio may remain on any scene** — only the single voiceover
   should be audible. A muted scene that still carries its auto-created inline audio clip
   is the doubled-audio bug; clear it before committing. (Reminder: adding a video overlay
   from a file with sound auto-creates an inline audio clip — muting a layer means removing
   that clip.)
2. **Scene shape.** Scene count + order match the beat plan? Keep stitched clips as
   SEPARATE per-beat scenes (the playback engine smooths seams) — don't collapse into one
   concatenated clip; concatenation is FINAL-EXPORT only. **STITCH face-check (applied-edge
   re-verify, per `stitching-multi-clip`): EXTRACT FRESH frames at each reused scene's
   COMMITTED-trim edges (≤0.5s step — sparse keyframes miss them), tighten via `update_overlay` + re-extract until clean. A described-but-unwritten trim shipped the 0:13/0:55 face leaks.**
3. **Overlays.** Every beat that planned on-screen text has a matching text overlay; no
   planned caption is missing AND no caption overflows — each line's `chars × 0.6 × fontPx ≤ 0.84 × width`.
4. **On mismatch:** do NOT commit. Tell the user the exact gap and the fix you'd apply
   (mute a scene's audio, add the missing VO / overlay, rejoin scenes), and get their OK —
   or let them say "commit anyway" to override intentionally.
5. **On match:** show the user the timeline (navigate them to the piece) — length, scene
   count, audio shape, cost. **STITCH — before commit, run `stitching-multi-clip`'s
   director's continuity review** (fresh-eyes/subagent pass over the spoken-script-in-order +
   seam frames; fix any repeated line, mid-sentence cut, or unmotivated time jump). Then
   commit — validate Stage 4.5 clips first if it reports `unvalidated_generated_clips`.

---

## The four hard gates

1. **Cost disclosure** — disclose the TOTAL estimated cost via `get_pricing` before any spend; respect the approval mode + batch cap.
2. **Dialogue confirmation** — run the [dialogue-gate](prompts/dialogue-gate.md) before any speaking clip (exact words + count + natural-pace fit; explicit `yes`). Separate from cost approval; re-run when the dialogue changes.
3. **Stage 4.5 validation + commit refusal** — every AI clip gets a real analysis record (frame vision-Read + video-understanding for manipulation beats); `commit_draft` hard-refuses unvalidated clips. (Inline above.)
4. **Verify-before-commit audio-shape** — the Stage 8 audio-shape + scene-count + text-overlay invariants must pass before `commit_draft`. (Inline above.)

---

## Naming + lineage

Every generated file is its own libi asset; multi-take variants of one beat are
separate assets grouped in **one folder** named after the beat (see
`using-asset-folders`). Name files descriptively (`hook.mp4`, `hook-v2.mp4`,
`body-2-ext1.mp4`) but treat the truth as the **notes field**, not the filename.

After EVERY save (generation, upload, extension, retry, rename), append a lineage
line to `files.notes` via `libi.update_file_notes`:

```
<ISO timestamp> | model=<id> | retry=<n> | parent=<fileId|null> | prompt-hash=<8 hex> | validation=<ok|minor|reject> [| issues=<n>]
```

`prompt-hash` is the first 8 hex of `sha256(prompt)` — a fingerprint you compute in
reasoning. Before reusing a prior take of a beat, read its notes and prefer the latest
`validation=ok` entry. On every AI upload, pass the FULL `aiGeneration` block (provider,
model, full prompt, `costEstimate`, `startedAt`/`completedAt`, `durationMs`,
`providerJobId`, `attemptNumber`) — it's the provenance `commit_draft` checks.

---

## Cross-skill references

- **`using-storyboard`** — the build spine (see "The Storyboard is the build spine" above). The
  schematic + generation-spec + take/select mechanics that realize the ad live there; this skill
  owns the UGC craft + gates that feed it. The ad's beat sheet / copy (Stage 3 — see
  [script-craft](prompts/script-craft.md)) becomes the Storyboard cards; get sign-off before
  materializing them.
- **`ai-asset-generation`** — the call + save mechanics (provider/model/schema/cost, prompt
  build, run/poll, import + provenance) plus the universal video invariants (no in-video text;
  native audio on). Never call provider tools directly.
- **`realistic-image-generation`** — the keyframe / creator-portrait image craft (gpt-image-2
  picker, anti-AI-look tokens, selfie/demographic templates, anatomy plausibility + validation).
- **`physical-action-video`** — manipulation-beat craft (FLF-first, prompt decomposition, the
  model-escalation ladder, editorial fallback, keep-isolated-clips-consistent).
- **`using-asset-folders`** — group multi-take variants + extend-chain clips.
- **`stitching-multi-clip`** — keep multi-clip routes as separate per-beat scenes;
  the editor's playback engine smooths the seams. Concatenation is only for FINAL
  EXPORT, not for the timeline.
- **`using-character-library`** — the general cross-piece objects catalog (characters + items) + disambiguation; proactively check it for the product/creator before generating fresh, and auto-catalog them from analysis if they're not there yet. This UGC skill's own local character/product references (Stages 1–2) are piece-scoped — promote a recurring one to the catalog when it's likely to come back in a future piece.
- **`using-snapshot-draft`** — the snapshot/draft model (see Rule 10 below).
- **`using-object-tracking`** — follow / blur / label a moving subject across a clip.

---

## Rule 10 — Snapshot/Draft awareness

Before starting, call `libi.get_piece_state` for the piece and check `hasDraft`. If a
draft exists with unrelated work, follow `using-snapshot-draft` Rule 2 (ask about
commit / discard / fold). After each major phase (character saved, scenes built,
overlays placed), suggest committing: *"Want me to save this as a snapshot before we
move on?"*
