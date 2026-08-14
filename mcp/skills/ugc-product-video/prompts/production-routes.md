# Production routes (footage axis)

This file is the **footage-axis** detail. `SKILL.md` routes here for the production route — i.e. *where the footage comes from*. There are two route families:

- **FROM-SCRATCH** — no source footage is reused. Either the **extend-chain** (internal **Path D**) or **multi-clip stitch** (internal **Path E**).
- **MIMIC-SOURCE** — the user has an existing video. Either **presenter-swap** (internal **Path A**), **restyle** (internal **Path B**), or **stitch source + AI** (internal **Path C**).

The A–E letters are **internal taxonomy only — never expose them to the user.** Translate every path into the plain-language sentences below before speaking to the user.

---

## Path choice (`pathChoice`)

"Which generation path?" Show the table below and let the user pick A / B / C / D / E / "run all five for comparison". Surface the recommended default per the source state:

| User state | Recommended default | Why |
|---|---|---|
| No source | **D** (extend chain) | No source to leverage; extend chain is the cleanest from-scratch flow. |
| Source exists, wants presenter-swap | **A** | Wan-Animate-Replace preserves the user's actual footage and just swaps the person — best fidelity. |
| Source exists, wants style change | **B** | Restyle keeps motion, changes look. |
| Source exists, wants entirely new content (using source as inspiration only) | **D** | Treat the source script as a beat-sheet template; generate new clips. |
| Source exists, wants variations to post (new character / hook / script, reusing the real product-demo footage) | **C** | The UGC variation default — regenerate the character-driven surrounding, reuse the identity-neutral product demo. Surface the stitching-seams warning. |
| Source exists, user explicitly says "keep me on camera, just fill the gaps" | **C** | Preserve-creator branch of C — REUSE person-on-camera, AI faceless inserts only. |
| User wants a head-to-head comparison | **"run all 5"** | Spawn 5 sibling pieces. Cost adds up (~$5–15 for five 30 s pieces). |

**Path identity reminder (INTERNAL — never expose these letters to the user):**
- A — character-swap on source via `fal-ai/wan/v2.2-14b/animate/replace`
- B — restyle on source via `decart/lucy-restyle` (or `fal-ai/wan/v2.2-a14b/video-to-video` if strength control needed)
- C — variation stitch: regenerate the character-driven surrounding with AI + reuse the source's identity-neutral product-demo (GATED: surface the warning verbatim before starting)
- D — generate from scratch with extend chain (`fal-ai/veo3.1/fast/extend-video` default; if the picked model lacks extend, switch to E)
- E — generate from scratch with multi-clip stitch (any i2v model that lacks extend; expects visible seams)

**User-facing language rule.** "Path A/B/C/D/E" is internal taxonomy — the user has no idea what it means. NEVER ask "Path D confirmed?" or name a path letter to the user. Translate to one plain sentence each:
- A → "swap the person in your video for a new character, keeping your original footage"
- B → "restyle your video (same motion, new look)"
- C → "make variations of your ad — regenerate the character / hook / script with AI and reuse your real product-demo footage (or keep yourself on camera and just fill the gaps)"
- D → "generate the whole thing fresh as one continuous shot (recommended for from-scratch)"
- E → "generate the whole thing fresh as separate clips stitched together"

If the user already told you what they want (e.g. "generate it fresh, don't reuse my clips" → D), DON'T re-ask — silently record the path and state your plan in plain words ("I'll generate this completely from scratch as one continuous shot"). Only present the option menu when the intent is genuinely ambiguous, and present it in the plain-language form above — never the letters.

**⚠️ Physical-manipulation override — decide this BEFORE you commit to a path.** Look at the ad's hero action. If the core beat is a fine physical manipulation of a small product — applying / pressing / peeling / inserting / twisting / sticking a small object onto or into something (e.g. applying a nail wrap, putting in a contact lens, peeling a patch, sticking on a lash) — then that beat is NOT generated as part of a continuous extend chain; **isolate it from the start.** The continuous-shot benefit of Path D **does not apply to a manipulation beat** — the extend chain is exactly what makes the manipulated object wiggle/shrink/vanish (the documented nail-wrap failure). *How* you fill the isolated beat (editorial before/after cut — the default for applying-onto-a-body-part; reuse the user's real footage; or a strong-model FLF attempt) is decided in the **Stage 3 weak-spot pass**. **The presence of a manipulation beat is the trigger — you plan to isolate it from the start; you do NOT wait for the user to complain that it "looks fake."**

### Per-path default video models

`videoModel` defaults are set by path. The user can override.
- Path A: `fal-ai/wan/v2.2-14b/animate/replace` (no other strong option)
- Path B: `decart/lucy-restyle` (cheap) or `fal-ai/wan/v2.2-a14b/video-to-video` (strength controllable)
- Path C: `fal-ai/veo3.1/fast/image-to-video` (best for AI infills that need to mimic the source; identity-filter avoided via image-to-video + action-only prompts)
- Path D: `fal-ai/veo3.1/fast/extend-video` (the only proven extend-capable model on fal today; if user picks another, agent must verify extend support at Step 4 dispatch)
- Path E: any i2v model the user picked that lacks extend (kling, hunyuan, etc.)

---

## Stage 0.75 — Reuse plan (path-aware)

Build the beat plan from the Stage 0.5 (and optionally 0.6) analysis. Per-path rules:

- **Path A (character-swap on source):**
  - Every segment where the presenter is visible → `replace` operation. Saved as a video clip via `libi.upload_file` after `fal-ai/wan/v2.2-14b/animate/replace` returns.
  - Every segment where the presenter is NOT visible (b-roll, hands-only, product close-up, endcard) → REUSE verbatim via `libi.trim_video` on the source.
  - Audio policy: keep source on every scene (inline AudioClips auto-create; agent does nothing).

- **Path B (restyle on source):**
  - Every segment → `restyle` operation via `decart/lucy-restyle` (or `wan v2v` with strength).
  - No REUSE / REGEN split — the whole timeline is the restyled source.
  - Audio policy: if Lucy is used (drops audio), add a standalone AudioClip from the source file synced to the timeline (or accept silent). If Wan v2v is used, audio passes through.

- **Path C (stitch source + AI infill — GATED):**
  - **Partition + voice owned by `stitching-multi-clip` — load it.** It decides REPLACE (new AI surrounding) vs REUSE (identity-neutral product demo), runs the no-reusable-section STOP gate, and the always-ask stitch voice policy. Mark each beat REPLACE (AI) or REUSE (trim source) per that skill — don't re-derive the rule here.
  - REGEN/AI prompts MUST include the Stage 0.6 per-shot style descriptors verbatim.
  - Audio routing is the `stitching-multi-clip` always-ask voice gate (reuse the source voice vs a fresh one; `@Audio1` sync by default, ElevenLabs only on an explicit voice-change) — see Stage 6.

- **Path D (extend chain):**
  - Not applicable — there's no per-beat reuse plan. The script is inspiration only.
  - The beat plan is just the engineered prompt sequence the agent will feed to the bootstrap + extend chain.

- **Path E (multi-clip stitch):**
  - Not applicable in the source-reuse sense. The beat plan is the sequence of independently-generated i2v clips.

Record the plan as the piece's `description` snapshot summary so a later agent run (or a different session) can resume.

---

## Stage 4 — Generation (dispatched by `pathChoice`)

> **Storyboard placement (default — read before any path below).** Every clip produced by the
> paths below is a Storyboard **card's take**. The generation *mechanics* of each path are
> unchanged — they are HOW you fill a card's take. What changes is *placement*: wherever a path
> says to "build the timeline with ONE video overlay per beat", or to place directly with
> "`libi.add_overlay({ kind: "video" })`", instead `libi.attach_storyboard_clip` the clip to its card and
> `libi.select_storyboard_take` to place the scene. Card↔clip mapping (from `SKILL.md`): a card
> = a generated clip = a scene; a *beat* is a jump-cut INSIDE a card; an **extend chain is ONE
> card** (the extend versions are its takes, the latest is the selected take, a rollback is
> selecting a prior take); a **stitch is N cards** (a reused beat is a card whose take is the
> source trim, an AI beat is a card whose take is generated — link consecutive cards with
> `libi.set_storyboard_reference` `reference_video` for continuity). The Stage 0.75 reuse plan
> below IS the card layout. Only on an explicit user opt-off ("skip the storyboard / just
> generate") do you place with `libi.add_overlay({ kind: "video" })` directly.

### MANDATORY for every path (v2.2)

**No in-video text.** Every video prompt (paths A, B, C, D, E) MUST include the no-text rule from `ai-asset-generation` Step 6.6 — variant of "no on-screen text, no captions, no signs, no labels in the background, no readable text on any object." Text that the script needs (product name, CTA, beat caption) is added via `libi.add_overlay({ kind: "text" })` after Stage 4.5 passes, never baked into the generation. SOTA video models cannot reliably render text; this rule is universal across paths.

If the beat plan has a `textOverlay` field (the planned on-screen text), that text is the agent's TODO for Stage 7 — not the model's job.

**Physical-manipulation beats (`physicalActionVerification: true`) — FLF-first + model ladder.** For any beat where a person manipulates a product (applying, peeling, pressing, pouring, gripping-and-releasing), you MUST follow `physical-action-video`: generate clean start + end keyframes and use a **first-last-frame** endpoint (default `fal-ai/veo3.1/fast/first-last-frame-to-video`), one dominant action, an object-permanence anchor ("the strip stays on the nail throughout"), tight shot, surgical negatives, ~4s. **Do NOT render a manipulation beat as a plain text/i2v shot inside a continuous extend chain** — that is exactly what produced the wiggling-then-disappearing nail strip in QA. Isolate the manipulation as its own FLF clip (Path E-style), and if it still fails Stage 4.5 after escalating Tier 0 → Kling 3.0 → Seedance 2.0, fall back to the **editorial before/after cut** (before-state clip → hard cut → after-state clip) or a real-product-photo overlay at the reveal. Background + citations: [docs-local/superpowers/notes/2026-05-28-physical-realism-flf-and-model-ladder.md](../../../../docs-local/superpowers/notes/2026-05-28-physical-realism-flf-and-model-ladder.md).

Each path is a self-contained sub-flow. Track progress with TodoWrite items per beat.

### Path A — Character-swap on source

For each `replace` beat from Stage 0.75:

1. `libi.trim_video` the source to the beat's `[startSeconds, endSeconds]` range → temp file.
2. Upload the trimmed segment to fal CDN via `fal-ai.upload_file` → segment URL.
3. Call `fal-ai/wan/v2.2-14b/animate/replace` with:
   - `video_url`: the segment URL
   - `reference_image_url`: the character ref portrait from Stage 1
   - any per-shot prompt details from Stage 0.5 (lighting, framing, mood notes)
4. Wait via `check_job`, fetch result URL, download to a temp path. Between `check_job` polls, use the `libi.sleep` tool to wait ~20s — see `ai-asset-generation` Step 8 for the full polling cadence rationale.
5. `libi.upload_file` with the new clip. **Pass `aiGeneration` with every field**: `provider: "fal-ai"`, `model: "fal-ai/wan/v2.2-14b/animate/replace"`, the full prompt, `costEstimate` (from `get_pricing`), `startedAt`/`completedAt` ISO timestamps, `durationMs`, `providerJobId`, `attemptNumber`.
6. Append the notes lineage line via `libi.update_file_notes`.

For each REUSE beat: just `libi.trim_video` the source. No fal calls.

### Path B — Restyle on source

For each beat:
1. `libi.trim_video` the source segment → temp file.
2. Upload to fal CDN.
3. Call `decart/lucy-restyle` (default, $0.01/sec) OR `fal-ai/wan/v2.2-a14b/video-to-video` (if user wants strength control). Pass the style prompt the user provided in Stage 0.
4. Save the result via `libi.upload_file` with `aiGeneration` populated. Append notes line.

**Audio caveat:** if using `decart/lucy-restyle`, the output is silent — Lucy drops the audio track. After the timeline is built, add a standalone AudioClip pointing at the source file with the matching scene's time range. If using Wan v2v, audio passes through and no extra step is needed.

### Path C — Stitch source + AI infill (surface the warning FIRST)

**Before any fal call, surface this warning verbatim:**

> Stitching path: some scenes will be your original footage, others AI-generated. The seams may look obvious if the AI generations don't match your source's lighting, color grade, framing, and camera shake. To minimize this, I'll run a paid script analysis on your source (~$0.15) and pass that style summary into every AI generation prompt. Still want to proceed with C, or would you prefer D (fully AI, no stitching seams) or A (presenter-swap on your real footage, no seams)?

Wait for explicit user confirmation before proceeding.

**Partition + stitch voice are owned by `stitching-multi-clip` — LOAD it before you draft the
stitch plan.** It is the single source of truth for the stitch: REPLACE (new AI for the
character-driven surrounding) vs REUSE (identity-neutral product demo), the no-reusable-section
STOP gate, the preserve-creator alternative, and the always-ask stitch voice policy (reuse the
source voice vs a fresh one). Do NOT draft the stitch partition or voice plan from this file —
load `stitching-multi-clip` (it loads `voiceover-production`) and follow it.

Then:

1. Stage 0.6 paid script analysis is MANDATORY here. If it wasn't run yet, run it now (after cost approval).
2. For each REUSE beat: `libi.trim_video` the source.
3. For each REPLACE (AI) beat:
   - **Talking-head beat (the variation default — a new on-camera character):** generate on
     `bytedance/seedance-2.0/reference-to-video` (native audio + voice carry). Pass the new
     character's start frame as `@Image1` and the main character's voice sample as `@Audio1`
     (both LOCAL files → `libi.upload_file_to_fal` first — NEVER read `FAL_KEY` or `curl` fal
     storage yourself), `generate_audio: true`, and the spoken line in the prompt. See
     `stitching-multi-clip` step 3 + `voiceover-production` for the one-voice rule.
   - **Faceless product / b-roll beat (no character):** call `fal-ai/veo3.1/fast/image-to-video`
     (or Seedance i2v) with the product/scene ref + an action-only prompt, augmented with the
     matching shot's Stage 0.6 descriptor: `<engineered prompt> | Source-style guidance: <shot
     taxonomy>, <lens>, <lighting>, <color>, <motion>`. No identity descriptors in the prompt
     (those go in the image input) — this also sidesteps Veo's identity filter (the Phase 4 fix).
   - Save via `libi.upload_file` with `aiGeneration`. Notes lineage line.
4. Stage 4.5 validation on every REPLACE (AI) beat (vision-read frames; regenerate failures).
5. **After all REUSE trims + REPLACE (AI) outputs are saved**, build the timeline with ONE full-frame video overlay per beat, sequenced by `startTime` in order — do NOT concatenate into a single preview clip. The editor's playback engine smooths the seams (preroll + background seam render-cache), and separate overlays keep each beat independently editable. Concatenation is a FINAL-EXPORT step only. See `mcp/skills/stitching-multi-clip/SKILL.md` for the multi-clip timeline + audio flow.

### Path D — Generate from scratch with extend chain

**Pre-flight: verify extend-capability of the picked model.**

If `videoModel` is NOT `fal-ai/veo3.1/fast/extend-video`:
1. Call `fal-ai.get_model_schema` on the picked model.
2. Look for an `extend` action OR an input that accepts the prior generation as `source_video_url` / equivalent.
3. If absent, surface this warning verbatim:

> The model you picked (`<model id>`) doesn't expose an extend/continuation API. To hit your target length of `<N>s` I have two options:
>
> (a) **Switch to an extend-capable model** (recommended) — `veo3.1/fast/extend-video` is the proven path. I'll regenerate from the bootstrap with that.
>
> (b) **Multiple-clip stitch with the same character ref (path E)** — I'll generate N separate clips from the same character image, each with a carefully-engineered prompt that tries to match the visual continuity (same lighting, framing, wardrobe, background). The seams may be visible because each clip is independently generated — the model has no memory of the last frame of the previous clip. I'll run Stage 4.5 validation on each clip to catch obvious mismatches, but expect 30–50 % to need regeneration to converge on consistent look.
>
> Which do you want?

If user picks (a): switch `videoModel` to `fal-ai/veo3.1/fast/extend-video`, continue with the flow below.
If user picks (b): switch `pathChoice` to `E` and jump to Path E flow.

**D flow (the extend chain returns the FULL clip on each call — do NOT trim):**

Important: Veo 3.1's `extend-video` endpoint returns the full chain on every call, not just the new tail. So if your bootstrap was 8 s and you extend by 7 s, the return is a single 15-second file containing the full bootstrap+extension. Treat each extend return as the new "current full clip" — do not slice it.

1. Stage 0.6 paid script analysis if `mimicSource` is set and user opted in (covered in Stage 0.6).
2. Stage 1 character image via the `realistic-image-generation` realism picker.
3. **Folder for the chain:** create one folder for the extend chain via `libi.create_asset_folder` (name it after the piece). Keep the resulting `folderId` in your TodoWrite — every clip in the chain goes into it.
3b. **Bootstrap clip:**
   - Call `fal-ai/veo3.1/fast/image-to-video` with the character ref + Beat 1's engineered prompt (action-only).
   - **veo3.1/fast prompt format (Fast ≠ full Veo 3.1):** feed ONE continuous action description. Do NOT use timestamp-bracketed multi-beat decomposition (`[00:00-00:02] …`) — the Fast endpoint misparses the brackets as missing-attachment refs and returns `no_media_generated` / Unprocessable Entity (a failed, unbilled round-trip). Timestamp decomposition is a full-Veo-3.1 feature only. Describe the single motion you want over the clip; if the action is too long for one clip, that's what the extend loop (step 4) is for.
   - Save the result via `libi.upload_file` as `<piece-name>-v1.mp4` with `folderId: <chain folderId>` + `aiGeneration` (model: `fal-ai/veo3.1/fast/image-to-video`, attemptNumber: 0, etc.) + notes lineage line.
   - Keep the resulting `fileId` in your TodoWrite — it's the current full clip.
4. **Extend loop — each iteration produces a NEW full-length file, NOT a tail:**
   - For each subsequent beat: call `fal-ai/veo3.1/fast/extend-video` with `source_video_url` = the previous extend's output (or the bootstrap clip on the first iteration) + the beat's engineered prompt.
   - Between `check_job` polls inside the `wait via check_job` step, use the `libi.sleep` tool to wait ~20s — see `ai-asset-generation` Step 8 for the cadence rationale.
   - Save the returned full-length file via `libi.upload_file` using `folderId: <chain folderId>` — each extend take is its own asset, grouped in the chain folder alongside the prior takes.
   - aiGeneration: `model: "fal-ai/veo3.1/fast/extend-video"`, `attemptNumber: N` where N is the iteration index, `providerJobId`, full prompt, cost.
   - Notes line includes `parent=<previous file id>` so the chain is reconstructible.
5. Continue until cumulative duration ≥ target.
6. **Track the latest extend as the current full clip** in your TodoWrite once you're happy with the final length. The prior takes stay in the folder for rollback.
7. **Composition has EXACTLY ONE full-frame video overlay** pointing at the latest extend file, with no trim set — create it with `libi.add_overlay({ kind: "video", fileId })` (omit `rect` and `duration`; both are auto-derived).
8. Stage 4.5 validation: vision-Read keyframes of the **final** extend output. If failure: point the layer back at the prior take's `fileId` (via `libi.update_overlay`), then re-extend from there with a corrected prompt.
9. Audio: keep model audio on the single scene (inline AudioClip auto-creates from the file's audio stream — no action needed).

**Common mistake to avoid:** do NOT save each extend's file as a separate asset and then sequence them with `trim` ranges. Veo's extend output already contains the prior content seamlessly; slicing it back apart re-introduces seam glitches that the model rendered out.

**Rollback recipe** (Stage 4.5 found the latest extend is bad):
1. List the chain folder's assets (`libi.list_assets`) → see all takes in the chain folder
2. Point the layer back at the last-good clip with `libi.update_overlay`. NOTE: this does NOT relink the layer's inline audio (it still references the old file). If the layer relies on its source audio, remove the stale inline audio clip (`libi.audio_remove_clip`) then recreate it from the new file (`libi.audio_relink_overlay`). (For the muted-layer + separate-VO layout this is a no-op.)
3. Re-call `extend-video` against the restored file with the corrected prompt → save as a new asset in the chain folder → point the scene at it
4. Re-validate.

### Path E — Multi-clip stitch (no-extend fallback)

For each beat (each beat = one independent clip):

1. Image-to-video using the same character ref + beat-specific prompt.
2. **Continuity language in the prompt** (verbatim): "same lighting as previous clip, matching <background> background, same outfit, same hair, continuous mood, no scene change".
3. For beats 2+: extract the last frame of the previous clip via `ffmpeg -ss <duration-0.1> -i <prev-clip> -frames:v 1 <out>.jpg`, vision-Read it via the agent's `Read` tool, then add 1–2 specific continuity hints from what you saw (e.g. "subject's hand on the silver bottle, light from upper-left, slight blur on background plant").
4. Save the new clip via `libi.upload_file` with `aiGeneration`. Notes line.
5. Stage 4.5 grade against continuity: A (matches previous), B (acceptable), C (visible mismatch — regenerate).
6. Auto-regenerate Cs in batch mode (within `batchCap`); ask user per-C in `ask-each`.

After all clips are saved, build the timeline with ONE full-frame video overlay per beat, sequenced by `startTime` in order — do NOT concatenate into a single preview clip. The editor's playback engine smooths the seams (preroll + background seam render-cache), and separate overlays keep each beat independently editable. Concatenation is a FINAL-EXPORT step only. See `mcp/skills/stitching-multi-clip/SKILL.md` for the multi-clip timeline + audio flow.

Audio: Path E is FULLY-AI — keep each clip's **native audio** (`generate_audio = true`); do NOT mute and do NOT lay a separate VO by default. For cross-clip voice consistency on a >15s ad, carry clip-1's voice via `reference-to-video` (`@Audio1`). See Stage 6 + `ai-asset-generation` Step 6.6.

**Budget warning:** path E typically eats 1.4×–2× the generation budget of an extend chain because of regenerations. Re-confirm with the user before starting if the projected cost exceeds the `batchCap`.

---

## Stage 5 — Build to target length

**Default to ONE full-length multi-beat clip** — favor the longest single clip the
model can produce, and keep REUSE (original-footage) cuts long rather than chopping
them to 3–4s. Only run the multi-clip loop below when the target genuinely exceeds
the model's single-clip max. Frontier models cap single-clip output at 8–15s; to
reach a `targetDuration` beyond the cap:

```
while currentDuration < beat.targetDuration:
  if model supports native video-to-video continuation:
    extend = call the upstream extension tool with the prior clip
  else:
    lastFrame = grab the prior clip's final frame (libi.generate_thumbnails)
    extend = ai-asset-generation image-to-video from lastFrame, continuing the action
  validate(extend)  # full Stage 4.5
  if rejected → patch prompt, retry (counts against batchCap)
  append extend asset (name: <beat>-ext<n>.mp4)
join the takes into one file (libi.concat_videos)  # stream-copy when same codec; expected for same-model outputs
```

**Detecting native extension support:** at start of Stage 4, call `libi.list_mcp_servers` to find the fal-ai tool surface (or just inspect your deferred tool list). If you see a tool name matching `*extend*`, `*continue*`, or `*video-to-video*` from fal-ai, prefer it — one fewer artifact and no codec mismatch. Otherwise use the image-to-video fallback.

Stitched chunks should be the same codec/resolution/fps as the base (same model = usually true). `libi.concat_videos` will choose stream-copy automatically when codecs match.

---

## Stage 6 — Audio (path-aware)

**Audio policy is owned by the `voiceover-production` skill — load it.** This stage
only notes the per-path *routing* specifics. The universal rules (native audio
always; multi-clip voice via `reference-to-video` `@Audio1`; mute only for real
source footage; a separate voiceover is explicit opt-in, ElevenLabs not Kokoro for
UGC) are NOT restated here — `voiceover-production` is the single source of truth.

The audio policy depends entirely on `pathChoice`. Get this wrong and the output sounds incoherent — voice tones changing between scenes, dialog overlapping, sections going silent (Phase 4 round 1 had all three).

| Path | Default audio policy | Agent action |
|---|---|---|
| **A** | Keep source audio on every layer (inline AudioClips auto-create). | None — `libi.add_overlay({ kind: "video" })` auto-binds the inline clip. Do NOT call `audio_remove_clip`. |
| **B** | If using Wan v2v: same as A (model preserves audio). If using Lucy: model drops audio → call `libi.audio_add_clip` with `kind: "standalone"` and `fileId: <sourceFileId>` to add the source's audio over the restyled visual. | Conditional on which B variant. |
| **C** (variation stitch) | Owned by `stitching-multi-clip`'s **always-ask** voice gate: reuse the source voice (KEEP the reused beat's VO + sample it for `@Audio1`) or a fresh AI voice — `@Audio1` sync by default, ElevenLabs only on an explicit voice-change. | Follow `stitching-multi-clip` step 3 + `voiceover-production` Rule 5. Whether a reused scene's inline source audio is **kept** (voice-reuse) or **removed** (fresh-voice) is decided there — do NOT blanket-mute. The only hard invariant: never TWO different voices on one scene (the doubled-audio bug). |
| **D** (fully-AI extend chain) | **Keep native model audio** (`generate_audio = true`). | None — inline clips inherit the native audio. See `ai-asset-generation` Step 6.6. |
| **E** (fully-AI multi-clip) | **Keep native model audio** (`generate_audio = true`) on every generated clip — do NOT mute, do NOT lay a separate VO by default. | None by default. Each AI clip is generated voiced. For cross-clip voice consistency on a >15s ad, carry clip-1's voice via the `reference-to-video` endpoint (`@Audio1`) — see `ai-asset-generation` Step 6.6 "multi-clip voice carry". |

> **Path E is FULLY-AI, not a source stitch — do not mute it.** Path E clips are
> independently *generated* (no real source footage), so they carry native AI audio that
> SHOULD play. The mute-everything-and-lay-one-VO policy is for Path C (real source
> footage that must be unified), NOT for Path E. Silencing Path E clips and overlaying a
> separate VO is the exact defect that shipped a voiceless ad. (If the user explicitly
> opts to toggle native audio off and add their own VO, that's fine — but it is their
> opt-in, never your default.)

> **⚠️ Doubled-voice failure mode (Path C, observed in QA 2026-05-30).** The bug is **two different voices on one scene** — it's conditional on the `stitching-multi-clip` voice choice:
> - **Voice-reuse:** the reused beat's source VO **stays** (it IS the main voice) and the AI beats are generated to MATCH it via `@Audio1` — so no scene carries a competing second voice. Do NOT strip the reused VO.
> - **Fresh voice:** the reused scene's inline source audio MUST be removed (`libi.audio_remove_clip` at scene-creation) so the source voice doesn't play under the new AI voice.
> Either way, PROVE it at Stage 8: read the composition back and confirm **no scene carries two voices**. (Paths D/E keep their native AI audio.)

**Voice file generation** (Path C source stitch, OR any path where the user explicitly
opted out of native audio): the provider choice, the consistent-voice-ID rule, the
`needs_config` STOP-and-ASK flow, and the never-fall-back-to-Kokoro-for-UGC rule are all
owned by **`voiceover-production`** — load it and follow it. This stage does not restate
them.

**No music in v2 default flow.** If the user explicitly asks for music: `local-music` (free, ACE-Step) or `elevenlabs.compose_music` (paid). Add via `libi.audio_add_clip` with `kind: "standalone"`. Optionally enable sidechain ducking via `libi.audio_duck_enable` so music dips under the VO.

**User override:** if user says "I don't like the audio in path A/B/D, give me a clean VO instead" — switch that path to the C/E audio rule (mute + standalone VO).
