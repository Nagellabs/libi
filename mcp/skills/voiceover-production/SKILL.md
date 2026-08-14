---
name: voiceover-production
description: The authority on AI-video audio + voice DURING GENERATION. Native audio ON by default (generate_audio=true); multi-clip voice consistency carried via Seedance reference-to-video (@Audio1), NEVER by muting clips + layering a TTS voiceover. Replacing or changing the voice on an EXISTING video is a separate, user-triggered flow — see the `voice-replacement` skill. Loaded BY orchestration skills — not a standalone entry point.
---

# Voiceover & Native Audio (generation-time authority)

This skill decides how an AI video gets its audio + voice **as it is generated**.
`ugc-product-video`, `generic-video`, `mimic-video`, and `stitching-multi-clip`
load it BY NAME — it is **not a standalone entry point**.

**Scope: native audio + voice CARRY only.** An AI video's audio comes from the
generation itself (native audio) and stays consistent across clips via the
`@Audio1` carry. This skill does **NOT** mute footage to layer on a different
voice. **Deliberately re-voicing an existing video — clone the original or pick a
new voice, lip-sync the talking parts, mute + add audio on the rest — is the
`voice-replacement` skill**, a separate flow the USER triggers explicitly *after*
the video exists. If a rule about generation-time audio, voice carry, or
native-audio defaults lives elsewhere, that place points here.

## The decision tree (key on the SOURCE of the footage)

1. **AI-generated clips — native audio, ALWAYS.** Set `generate_audio = true` on
   every clip on a model with native audio (Seedance 2.0, Veo 3.1). The spoken
   voice is baked into the generation. **Muting an AI generation is a defect**, not
   a "clean" result — never `generate_audio = false` to "add the voice later."

2. **Multi-clip (> ~15s) that needs ONE consistent voice — carry it via
   `reference-to-video`. This is the STANDARD multi-clip voice path, not an
   experiment, and you MUST attempt it:**
   - Generate clip-1 on `image-to-video` (`generate_audio = true`).
   - **Extract clip-1's audio** — `libi.extract_audio(...)`. It **defaults to MP3** (fal-safe);
     `audio_urls` accepts MP3/WAV ONLY. Just **never pass `format: "copy"`** for an `@Audio1`
     file — that stream-copies to `.m4a`/AAC, which Seedance **REJECTS (HTTP 422)**.
   - Generate clip-2+ on **`reference-to-video`**, passing that MP3/WAV file in
     `audio_urls` (cited in the prompt as `@Audio1`) + the character image in
     `image_urls` (`@Image1`). State the invariant in words next to the token:
     *"keep the voice from `@Audio1`"*, *"the same woman from `@Image1`"*.
   - **Do NOT pre-emptively mute the clips and layer a separate TTS voiceover.**
     That is the exact regression this skill exists to stop.
   - If the carried voice underperforms, **surface it to the USER** (show/play the
     result). If they then want a different or cloned voice, that is the
     **`voice-replacement`** skill (a separate, user-triggered step) — do NOT
     silently substitute a VO here.

3. **Real source footage (a stitch route) — keep its own audio, or carry via
   `@Audio1`.** Reused source clips bring their own voice; that voice is the
   cheapest, most consistent spine for the stitch (rule 4). Do NOT mute it to layer
   a different voice as part of generation. Generation-time audio here is native +
   carry only. **If the user later wants a different voice on the finished stitch,
   that is the `voice-replacement` skill** — a separate, explicit, user-triggered
   flow that owns the mute-and-revoice + lip-sync logic.

4. **Stitch voice — ALWAYS ASK first, then default to Seedance `@Audio1` sync (never ElevenLabs
   by default).** A stitch mixes reused source beats with new AI beats; the goal is ONE consistent
   voice across the whole piece WITHOUT a clone. **Ask the user up front:** *"Reuse the voice from
   your source, or give the new creator a fresh voice?"* — and **explain the trade-off they can't
   see**: if a beat you plan to REUSE already carries the source creator's voiceover, that voice is
   the cheapest, most consistent spine for the whole piece. Let them choose before you generate.

   - **(A) Reuse the source voice — DEFAULT when a reused beat carries the actor's voiceover.**
     That source voice becomes the MAIN voice: **keep the original voiceover on the reused scenes
     (do NOT mute them)**, cut ONE clean **≤15s** sample of it (`libi.extract_audio`
     `format:"mp3"` over a continuous, music-free stretch — never `format:"copy"`, AAC is REJECTED
     422), and generate every new AI talking-head beat on **`reference-to-video`** with that sample
     as `@Audio1` (+ the beat's start frame as `@Image1`, `generate_audio: true`). The new beats
     then speak in the source voice → one voice across the whole video, **no silent gaps, no
     ElevenLabs.** (A new on-camera creator is a *visual* swap; the voice stays the source's.)
   - **(B) Generate a fresh voice — when the reused beats have NO dialogue, or the user wants a new
     voice.** Generate the FIRST new AI clip with native audio (`generate_audio: true`) to
     establish the voice, extract a clean ≤15s sample → `@Audio1`, and reuse it on every other AI
     beat (`reference-to-video`) for continuity. Dialogue-free reused scenes are left ambient (or
     muted) under that voice.
   - **Always generate voice on AI clips** (`generate_audio: true`) — a silent generation is a
     defect (rule 1).
   - **Match the source speaker's DELIVERY in the clip prompt.** `@Audio1` carries the voice
     *timbre*, but the new beats speak NEW lines whose **pace, energy, and cadence come from the
     generation prompt**. Read the source's delivery from the analysis/transcript — talking
     **speed** (fast/clipped vs slow/measured), tone, energy, accent — and state it in every AI
     talking-head prompt (e.g. *"speaking quickly and energetically, fast-paced casual UGC
     delivery"*) so the new creator sounds like the SAME person as the kept source-VO middle. A
     delivery-speed mismatch breaks the one-voice illusion even when the timbre matches.
   - Local refs reach fal via **`libi.upload_file_to_fal({ fileId })`** (key server-side —
     **never** read `FAL_KEY` or `curl` fal storage yourself). Reuse the SAME `@Audio1` on every
     AI beat; persist the chosen sample as a per-character voice asset (`using-character-library`)
     so the SAME voice runs across the other variation videos. `stitching-multi-clip` owns the
     stitch step-by-step + the always-ask gate; `model-seedance-2` owns the `@Audio1`/`@Image1`
     mechanics.

   **A voice CHANGE — a voice that is neither the source's nor the native AI voice (a
   specific/branded read or a clone) — is NOT done here.** It is the `voice-replacement`
   skill: a separate, user-triggered flow that runs AFTER the video exists. During
   generation, never mute the `@Audio1` carry to substitute a voice, and never ship
   silent inserts.

## Re-voicing an existing video → `voice-replacement`

Replacing or changing the voice on a video that already exists — clone the original
or pick a new voice, lip-sync the talking sections, mute + add the new audio on the
rest — is **NOT** part of generation and is **NOT** owned here. It is the standalone
**`voice-replacement`** skill, which the USER triggers explicitly ("change the
voice", "add a different voiceover", "re-voice / dub this video"). This skill stops
at native audio + `@Audio1` carry; hand off to `voice-replacement` for anything that
swaps the voice on finished footage.

## What this skill does NOT own

The low-level generation CALL (`generate_audio` is a param on the video-gen tool)
and the dialogue↔audio coherence rule ("never write spoken lines into a silenced
clip") live in `ai-asset-generation`. The `@Image1` / `@Audio1` token *syntax* and
per-engine specifics live in `ai-video-models` (`model-seedance-2`). **Re-voicing an
existing video (clone/new voice + lip-sync + mute) is owned by `voice-replacement`.**
This skill owns only the generation-time DECISION (native audio vs `@Audio1` carry).
