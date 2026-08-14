<!-- Adapted from krusemediallc/arcads-claude-code (MIT, © Caleb Kruse / Kruse Media LLC).
     Reworked for libi tooling (ai-asset-generation flow, fal-ai model ids, libi.upload_file). -->

# Seedance 2.0 — platform guide

These are the rules for how **Seedance 2.0** interprets a prompt. Apply them on
top of whichever use-case formula you pick (UGC, product hero, feature
walkthrough, premium reveal, studio lookbook). Read this file once before
composing any Seedance prompt, then read the matching use-case formula from the
`ugc-product-video` skill's `prompts/` folder.

> **libi mechanics first.** You do NOT call Seedance directly. All generation
> runs through the `ai-asset-generation` skill — it owns provider selection,
> approval, and the `fal-ai` model ids. This file is the *prompting* layer; the
> `ai-asset-generation` skill is the *plumbing* layer. Seedance 2.0 endpoints
> that matter:
> - **`bytedance/seedance-2.0/image-to-video`** — the default. ONE start frame
>   (`image_url`) + optional `end_image_url` (FLF), `prompt`, `duration` (4–15s),
>   `resolution`, `aspect_ratio`, `generate_audio` (defaults **true**). **No
>   reference-token mechanism and no audio input** — it animates the single start
>   frame.
> - **`bytedance/seedance-2.0/reference-to-video`** — the multi-reference endpoint.
>   Three reference modalities, each cited by token in the prompt (verified live fal 2026-06-08):
>   `image_urls` (JPEG/PNG/WebP, up to 9, `@Image1`…), `audio_urls` (**MP3/WAV, up to 3,
>   combined duration ≤15s, ≤15 MB/file**, `@Audio1`…), and `video_urls` (MP4/MOV, up to 3,
>   **combined 2–15s, <50 MB total, ~480–720p each**, `@Video1`…). **Total files across all
>   modalities ≤12.** A reference *guides* the generation — audio is a voice **conditioning**
>   reference (under `generate_audio: true` the model produces lip-synced speech in that voice),
>   NOT a literal audio overlay. **Hard rule: if you pass `audio_urls` you MUST also pass at
>   least one `image_urls` or `video_urls` entry — audio alone is rejected.** Use this endpoint
>   to bind multiple reference images, to carry a voice across multi-clip generations, or to
>   carry the original creator's voice into a stitch's faceless AI inserts (see "Native audio +
>   multi-clip voice carry" below).
>
> **Cheaper "fast" tier.** Each of the two above has a real lower-cost variant —
> **`bytedance/seedance-2.0/fast/image-to-video`** and
> **`bytedance/seedance-2.0/fast/reference-to-video`** (verified live, ~half the
> price, identical input shape incl. `generate_audio` / `end_image_url` / `duration`).
> These are the right pick for an **eval / draft pass** on a tight budget — surface
> the choice + price to the user (don't silently downgrade for hero/final work).
> ⚠️ **Known issue (2026-06-06):** a real-AI run on the `fast/image-to-video` endpoint
> came back COMPLETED but its *result* 404'd via the bundled fal MCP (the result URL
> dropped the `bytedance/` vendor segment), so no usable clip landed. The endpoint is
> real — this is a fal-client/result-fetch issue. Apply the **completed-but-empty
> guard** below, and if a fast job comes back empty, fall back to the standard
> (non-`fast`) endpoint rather than re-spending on the same path.
>
> **Endpoint paths are exact — do NOT invent tier/segment variants.** Use ONLY the
> four ids above (verify each with `get_model_schema` before `submit_job` — a 404 /
> empty schema means the path is wrong; never submit to an unconfirmed id).
>
> **Completed-but-empty guard (applies to EVERY generation, all providers).** A job
> that reports `completed` is NOT proof of a usable output. Treat it as **FAILED** —
> do not import it, do not count it as delivered, do not move to the next clip or
> commit — whenever ANY of these hold: `inference_time` is implausibly low for the
> work (e.g. < ~1s for a multi-second video), the result URL 404s / is missing, or
> the output file can't be fetched + imported via `libi.upload_file`. The only proof
> a generation succeeded is a fetched, imported output file of the expected media
> kind. On a phantom-`completed` job: retry (different tier/endpoint/params), and tell
> the user it did not actually generate — never silently treat it as done.
>
> Always confirm the live capability/price at runtime via the fal tools
> (`recommend_model` / `get_model_schema` / `get_pricing`) — pins drift.

## Reference images, not an API array

The arcads original passed product images via a `referenceImages` array on its
own HTTP route. In libi you do it the libi way:

1. The user's product image (or an image you generated in an earlier stage)
   already lives as a libi file. If it's on the local filesystem, import it with
   `libi.upload_file`.
2. The `ai-asset-generation` skill wires that file in as the i2v source /
   reference when it calls the fal endpoint and records the lineage on the
   resulting file's `aiGeneration` provenance.
3. To use a LOCAL libi file as a `reference-to-video` `image_urls` / `audio_urls`
   input (`@Image1` / `@Audio1`), turn it into a fal-hosted URL with
   **`libi.upload_file_to_fal({ fileId })`** — it returns a cached fal CDN URL and
   the FAL key is handled server-side. **NEVER** read `FAL_KEY` from the DB/env/shell
   or `PUT`/`curl` bytes to fal storage yourself — you don't hand-manage a
   presigned-URL array or any credential.

### Reference tokens — `@Image1` / `@Audio1` (reference-to-video ONLY)

The correct fal token syntax is **`@Image1`, `@Image2`, …** for reference images and
**`@Audio1`, `@Audio2`, …** for audio references — capital `Image`/`Audio`, no
parentheses. (An earlier version of this guide wrote `@(img1)`; that syntax is wrong
and the model ignores it.)

**These tokens ONLY work on the `reference-to-video` endpoint** (the one with
`image_urls` / `audio_urls` arrays). On the default **`image-to-video`** endpoint there
is a single `image_url` (the start frame) and **no token mechanism** — do NOT sprinkle
`@Image1` / `@(img1)` into an image-to-video prompt. They are ignored noise that clutters
the prompt; the start frame already IS the reference. (A real run pasted `@(img1)` six
times into an i2v prompt — pure waste.)

When you ARE on `reference-to-video`:
- Reference each supplied image/audio exactly once by its token in the prompt text,
  in the same index order you passed the URLs.
- State the invariant in plain words next to the token: *"the same woman from `@Image1`
  in every cut"*, *"keep the voice from `@Audio1`"*.

## Prompt length: 100–260 words

This is the sweet spot. Shorter prompts produce vague, drifting output; longer
ones overwhelm the model and it loses the key details. Every formula file targets
this band — count your words before you submit.

## Prompt order: Subject + Action + Camera + Style + Constraints

Seedance 2.0 responds best to this fixed ordering:

| Slot | What goes here |
|---|---|
| **Subject** | who/what is in the scene — age, clothing, expression, posture, product |
| **Action** | what happens — present tense, **one** primary movement per shot |
| **Camera** | framing (wide / medium / close-up) + movement (dolly-in, pan, handheld) |
| **Style** | visual tone — lighting, color, atmosphere (see the style whitelist below) |
| **Constraints** | artifact reducers — "maintain face consistency", "steady motion", "no distortion" |

The use-case formulas layer their own structure on top of this skeleton — but the
underlying flow always reads Subject → Action → Camera → Style → Constraints.

## Be explicit about motion (degree adverbs)

The model can't infer intensity from a still. Don't write "she picks up the
bottle" — write "she **slowly** picks up the bottle with her right hand, turning
it toward the camera." The degree adverbs that move the needle:

> **slowly · gently · quickly · casually · deliberately**

Every action verb should carry a degree and a direction. "Moves" is never enough.

## Consistency anchors

Without an explicit anchor, the product subtly mutates between cuts. State the
invariants directly in the prompt:

- "The product stays visually unchanged in every shot." (on `reference-to-video`,
  write "the product from `@Image1` stays visually unchanged in every shot")
- "Maintain product design and label details throughout."
- "Keep outfit unchanged across all cuts."

Pick the anchors that match your formula (product hero anchors the product;
UGC and walkthrough anchor both product and outfit).

## Style whitelist

Always include at least one style anchor. Stay inside this whitelist:

| Keyword | Effect |
|---|---|
| `documentary` | natural, observational feel |
| `photorealistic` | grounded in reality, no stylization |
| `handheld` | reinforces the phone-filmed look |

For premium / product-hero work, use `dramatic` or `premium` — **never**
`cinematic`. See the `forbidden-words.md` prompt in the `ugc-product-video` skill
for the full ban list and substitutions; this file does not re-list them. The
short version: no `cinematic`, `professional`, `stunning`, `8k`, `studio`, `perfect`.

## Timestamp pacing for multi-beat clips

For a clip with clear choreography across multiple beats, timestamp blocks give
you control over pacing and stop the model from rushing:

```
[00:00] A guy sits in his car, holding an electrolyte packet. Medium shot, dashboard light.
[00:05] He slowly pours the packet into his water bottle and shakes it. Close-up on hands.
[00:09] He takes a sip, pauses, nods with raised eyebrows. Back to medium shot.
[00:13] He holds the packet up to the camera, half-smile. "Yeah, these are legit."
```

Use timestamps for: multi-shot choreography, pacing control (anti-rush), and
style/camera transitions within one clip. Keep each block to **one** main action.
Clear timing = cleaner motion.

## No in-video text — add it later as an overlay

This is a hard rule across every libi generation path (see `ai-asset-generation`
Step 6.6). Do not ask Seedance to render captions, signs, labels, taglines, or
any readable text inside the video — generated text warps and breaks Stage 4.5.

- Phrase the exclusion positively in the prompt
  (e.g. "[bottle with a small unbranded label area]").
- After Stage 4.5 passes, add the text as a libi text overlay via
  `libi.add_overlay({ kind: "text" })` — crisp, editable, and exportable through the ffmpeg
  overlay backend.

> Some formula files (premium reveal especially) describe "text reveals" as part
> of the model's storytelling. That tension is called out in each file: prefer
> the libi overlay for any brand lockup / CTA you need to be pixel-crisp, and let
> the model carry only loose, decorative motion-text if at all.

## Duration ↔ dialogue

Seedance 2.0 supports **4–15 seconds** (continuous, not an enum). For no-dialogue
styles (product hero, premium reveal) default to **15s**. Embed the spoken line in
the `prompt` field as `She says: "…"` / `He says: "…"`.

**Native audio is ON by default (`generate_audio = true`), and dialogue must match it.** This is the
universal rule from `ai-asset-generation` Step 6.6 — every spoken beat is voiced natively in the
clip. **Therefore: only write `She says: "…"` lines when the clip is `generate_audio = true`.**
Never put spoken lines in a clip you are silencing — a prompt full of dialogue on a
`generate_audio = false` clip is the contradiction that shipped a silent ad. If a beat is meant to
be silent, write the action with no dialogue (leave `generate_audio = true` for ambient/SFX).

**Default to ONE 15s multi-beat clip — do NOT generate one clip per beat.** Seedance renders the
Hook/Show/Demo/Verdict beats as jump cuts INSIDE a single prompt, so the whole ad is one ~15s
generation. Generating a separate 3–4s clip per beat is the over-fragmentation that produces fast,
incoherent pacing — and the "short clips avoid drift" worry does NOT apply here (jump-cut beats in
one prompt are discrete shots, not a drifting continuous take). The word-count→duration table + read-aloud
discipline live in the **`ugc-craft`** skill (Clip-duration methodology); apply it
to the whole clip's script against this 15s cap.

**Pace beats by description, not hard timecodes.** Write the jump cuts as a short ordered list of
actions with pacing cues ("she pauses, then…"), NOT precise `[00:00] / [00:03]` timestamps. Seedance
does not honor exact timecodes, and a 5-beats-into-15s timecode block reads as rushed — pick 2–4
beats (per `ugc-craft`) and let the model space them.

### Native audio + multi-clip voice carry

For a target longer than 15s you'll need 2+ clips. To carry ONE voice across them:
generate clip-1 on `image-to-video` (`generate_audio = true`), then **extract clip-1's
audio as MP3/WAV** (`libi.extract_audio({ format: "mp3" })`) and generate clip-2+ on
**`reference-to-video`**, passing that audio file in `audio_urls` (cited as `@Audio1`) and
the character image in `image_urls` (`@Image1`). This is the **standard multi-clip voice
path** — attempt it; do NOT mute the clips and lay a separate TTS voiceover. If the carried
voice underperforms, **surface it to the user** (offer the opt-in voiceover) — do NOT
auto-substitute a VO. The audio DECISION lives in the `voiceover-production` skill; this
section is the seedance mechanics for it.

> ⚠️ **`audio_urls` accepts MP3 / WAV ONLY.** `libi.extract_audio` **defaults to MP3** (fal-safe),
> so a plain call already gives you a usable `@Audio1` file — good. The ONE way to get this
> wrong: passing **`format: "copy"`**, which stream-copies the source to **`.m4a` / AAC**, a
> format Seedance's `audio_urls` **REJECTS (HTTP 422)**. So: use the default (or `format: "mp3"`/
> `"wav"`) for any `@Audio1` reference, and **never `format: "copy"`** for it. If you ever see a
> 422 on a reference-to-video call, the audio format is the first thing to check. (Applies to
> BOTH the multi-clip carry above and the stitch source-voice carry below.)

**Stitch inserts — carry the SOURCE creator's voice (default, no cloning).** When
stitching real footage with faceless AI inserts, you have the original on the piece.
Extract ONE clean **≤15s** sample of the original **main speaker's** voice as **MP3/WAV**
(`libi.extract_audio` with `format: "mp3"` + `startSeconds`/`endSeconds` over a continuous,
music-free speech stretch), then generate each voiced insert on **`reference-to-video`**
passing that sample in `audio_urls` (`@Audio1`) **plus the insert's start frame in
`image_urls` (`@Image1`)** — the pairing is mandatory (audio alone is rejected) — with
`generate_audio: true` and the beat's narration line in the prompt
(*"spoken in the voice from `@Audio1`, continuing the creator's voiceover; the b-roll from `@Image1`"*).
Reuse the SAME `@Audio1` sample on every insert so one voice runs through the whole piece.
The insert needs no on-camera face — Seedance emits the spoken line as the clip's audio
track, so this voices b-roll without depicting the character. This is the DEFAULT stitch
audio path; ElevenLabs cloning is the explicit opt-in fallback only. `stitching-multi-clip`
owns the step-by-step; `voiceover-production` owns the decision.

## First-last-frame (FLF) on Seedance

Seedance 2.0 exposes FLF as a **parameter on the i2v endpoint**, not a separate
endpoint: pass an `end_image_url` to `bytedance/seedance-2.0/image-to-video`
alongside the start image. Use this for physical-manipulation beats where the
start and end state must be exact (see `physical-action-video` for the
FLF-first discipline and the model-escalation ladder). The `ai-asset-generation`
skill drives the actual call — you just decide the start/end frames.

## Iteration: one element at a time

If a generation is close but wrong, change **one** thing and re-run:

1. Action good, framing off → adjust the **camera** description only.
2. Pacing rushed → **cut dialogue / drop a beat** (do NOT add hard timecodes).
3. Product drifts between shots → add a **consistency anchor**.
4. Motion too stiff → add **degree adverbs** (slowly, casually, deliberately).

Never tune two variables at once — you lose the signal on which fix worked.

## Use-case formula directory

Genre use-case formulas (e.g. UGC product-hero, feature-walkthrough, premium-reveal) live in
the calling creation skill — see `ugc-product-video`'s `prompts/` for the UGC recipes. This
guide covers only the genre-neutral Seedance prompting rules above.

## Adaptation checklist (all formulas)

Before submitting any Seedance 2.0 prompt, verify:

- [ ] **Word count** — 100–260 words
- [ ] **Prompt order** — Subject → Action → Camera → Style → Constraints
- [ ] **Motion specificity** — every action carries a degree adverb + direction
- [ ] **Consistency anchors** — product / outfit stated as unchanged across shots
- [ ] **Reference tokens** — `@Image1` / `@Audio1` used ONLY on `reference-to-video`; NO tokens in a plain `image-to-video` prompt
- [ ] **Native audio** — `generate_audio = true` (default); spoken `She says:` lines ONLY on a voiced clip, never on a silenced one
- [ ] **Style anchor** — at least one whitelist keyword (documentary / photorealistic / handheld; dramatic / premium for hero work)
- [ ] **No forbidden words** — see the `forbidden-words.md` prompt in the `ugc-product-video` skill
- [ ] **No in-video text** — captions/brand/CTA queued for `libi.add_overlay({ kind: "text" })` instead
- [ ] **Duration** — sized via the `ugc-craft` word-count→duration method (4–15s), or 15s for no-dialogue
- [ ] **Beats** — 2–4 description-paced jump cuts, NO hard `[00:00]` timecodes
