---
name: voice-replacement
description: Use when the user asks to CHANGE, REPLACE, RE-VOICE, or DUB the voice on one or more EXISTING videos/scenes in a piece — a deliberate, user-triggered step AFTER the video exists ("change the voice", "give it a different voiceover", "redo the voice", "dub this", "clone my voice over it", "new narrator"). This is NOT initial generation (that keeps native audio via voiceover-production). It transcribes the target scenes, asks whether to clone the existing voice or pick a new one, lip-syncs the sections where a character speaks on camera, and mutes + re-voices the rest. A standalone entry point with its own trigger.
---

# Voice Replacement — re-voice an existing video

The user has a video (one or more scenes) and wants a **different voice** on it —
cloned from the original speaker or a brand-new voice. This is a separate flow from
generation: by default a piece keeps its native / `@Audio1`-carried audio
(`voiceover-production` owns that). Run THIS skill only when the user explicitly
asks to change/replace the voice on footage that already exists.

**Two hard principles** (carried over from `voiceover-production`):
- **MUTE, never delete** the original audio — `libi.audio_update_clip({ clipId, enabled:false })`,
  not `audio_remove_clip`. The original stays on the timeline and is one-click-toggleable
  (per-clip speaker icon); `audio_relink_overlay` is the only recovery if it was deleted.
- **Cover the actual speech.** Each new voice segment must cover what was actually said in
  that scene (sized from the transcript) — not a short summary that under-fills and leaves
  the speaker silent. `≤` scene duration is a guardrail against overflow, not the target.

## Workflow

### 0. Scope — which scenes?
Ask (or confirm) which scenes get the new voice: **all** of the piece's video overlays,
or a **subset** (e.g. "just the hook and verdict"). List the scenes you'll touch back
to the user before spending anything.

### 1. Transcribe each target scene (reuse if it exists)
For each target scene's video file, get a transcript **with word-level timing** — this
is the coverage anchor (it tells you WHO speaks, WHEN, and for HOW LONG):
- **Reuse first:** `libi.analysis_get({ fileId })` — if a transcript already exists, use it.
- **Else transcribe:** run the **`audio-analysis`** skill (local Whisper, free, word-level
  timing) on each target scene's video. ElevenLabs STT only if diarization is needed.
Record, per scene: the spoken text, the speech start/end within the scene, and the
talking **duration** (so the new segment can match it).

### 2. Choose the voice — ASK (clone vs new), and SUGGEST the provider by FORMAT
**Ask the user:** *"Clone the existing speaker's voice, or use a new voice?"*
- **Clone the original** → **ElevenLabs `voice_clone`** (only ElevenLabs can clone) from a
  clean ≤15s sample (`libi.extract_audio` over a continuous, music-free stretch). Persist it
  as a per-character voice asset (`using-character-library`) so the same clone is reusable.
- **New voice** → recommend the provider by the video's **format/genre** (read it from the
  piece/script or ask), and tell the user the trade-off:
  - **UGC / influencer / talking-head testimonial / authentic social** → **ElevenLabs**
    (expressive, authentic, "real person" delivery). Kokoro reads as flat/synthetic here.
  - **Narration / explainer / how-to / documentary / corporate / educational / neutral VO**
    → **local Kokoro is a great free default** (clean, on-device, no key); offer ElevenLabs
    as a paid quality upgrade if they want more expressive or branded delivery.
  - **Unsure / mixed** → state both and let the user pick; default to the format above.

**Cost + key gating:** ElevenLabs (clone or voice) is **paid** — disclose cost and get
approval before generating. If ElevenLabs has no key, ask the user to configure it
(Settings → MCP Servers) OR, when Kokoro fits the format, offer Kokoro instead. Kokoro is
free and needs no key. **Match the provider to the format — don't force ElevenLabs on a
plain narration, and don't push Kokoro onto a UGC talking-head.**

### 3. Classify each target section — does a character speak ON CAMERA?
For each target scene, decide using the analysis (`FrameDescription.people[]` /
`VideoSummary.subjects[]`) or your read of the footage:
- **Talking-face section** — an on-screen person whose mouth is visibly speaking. The new
  voice MUST match the lips → **lip-sync** (step 4a).
- **Voice-only / b-roll section** — no visible speaking face (hands, product, off-camera
  narration, faceless demo). No lips to match → **mute + re-voice** (step 4b).

### 4. Apply, per section

**4a. Talking-face → lip-sync via the fal.ai SOTA model.** Generate the new per-scene voice
segment (cloned/new voice, sized to the transcript — step 5), then lip-sync the scene's
video to that audio with the **best fal.ai lip-sync model**, through the **`fal-ai` MCP**
(libi has no local lip-sync engine — the hosted model is the quality path):
- Confirm `fal-ai` is configured (`libi.list_bundled_mcps`). If it isn't, ASK the user to add
  a fal.ai key (Settings → MCP Servers) — lip-sync needs it. If they decline, fall back to 4b
  (mute + new VO) for the talking section and **DISCLOSE the lips won't match the new voice**.
- **Upload BOTH the scene's video and the new VO audio to fal** with
  `libi.upload_file_to_fal({ fileId })` — the key stays server-side; **NEVER** read `FAL_KEY`
  or `curl` fal storage yourself.
- Run the **best lip-sync endpoint** via the `fal-ai` MCP (`run_model` / `submit_job`).
  **Default to sync.so Lipsync 2 — `fal-ai/sync-lipsync/v2`** (studio-grade, frame-accurate);
  `fal-ai/latentsync` is a cheaper open-source alternative. Pass the uploaded video URL +
  audio URL. **PAID — disclose the cost (~$ per minute of video) and get approval first.**
- Import the returned synced video (`libi.upload_file`), add it as a **second Asset Option**
  on the scene's video asset, and `libi.set_default_option` to promote it (rewrites the draft
  `scene.fileId`) so the preview shows the matched lips. The original stays a revertible
  option; the new VO is the audible track.

**4b. Voice-only / b-roll → mute + re-voice.** **Mute** the scene's inline source audio
(`audio_update_clip({ enabled:false })`), then add the new voice segment as a **standalone**
`audio_add_clip` at the scene's **start time** (walk `manifest.sceneOrder` summing prior
durations).

### 5. Size every segment to the speech (coverage)
For each scene, the new voice segment's length should **match the scene's actual talking**
(from the step-1 transcript), so it covers the same speech the original had — not a short
paraphrase. If the speaker talked ~14s in a 15s scene, the new line is ~14s. If natural
delivery would overflow the scene, prefer nudging `speed` slightly or trimming filler —
**never drop content that leaves on-camera speech silent.** Place each segment at its
scene's start; keep it within the scene's duration.

### 6. Verify before commit
- Every target scene: original inline audio **present but `enabled:false`** (muted, toggleable).
- Every target scene: a new voice segment that **covers its speech** (no silent talking tail).
- Talking-face scenes: lip-synced via the fal.ai model (or the no-fal fallback disclosure was made).
- Untouched scenes (if a subset): unchanged.
Report the final per-scene layout (muted original + new segment start/duration, lip-synced y/n).

## What this skill does NOT own
Generation-time audio (native audio, `@Audio1` carry) is `voiceover-production`.
Transcription mechanics are `audio-analysis`. The lip-sync MODEL is hosted on fal.ai
(`fal-ai/sync-lipsync/v2` etc.), reached through the `fal-ai` MCP — there is no local
lip-sync engine. This skill owns the DECISION flow for
re-voicing finished footage: transcribe → clone/new → lip-sync vs mute+re-voice → cover.
