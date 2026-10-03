---
id: voice-replacement-talking-face-lipsync
title: Re-voicing an on-camera speaker discloses cost and waits, lip-syncs, then swaps the overlay to the synced file with exactly one audible voice
skills: [voice-replacement, audio-analysis, ai-asset-generation]
mcps: [elevenlabs, fal-ai]
# Local Whisper for step 2's transcript (the 01 sibling's reasoning): without uv and the weights the
# hermetic home stops at needs_install. The clip below carries a sine tone, not speech, so the
# transcript comes back empty — the prompt hands the agent the spoken line instead.
share: [bin, models]
fixtures: [__tests__/helpers/fixtures/video/clip-red-3s.mp4]
agent: claude-code
runs: 1
timeoutSec: 1500
# The behaviour under test includes "does not spend before the yes", so the default
# pre-authorization (which tells the agent the opposite) is off. A scripted scenario's
# preamble then says money needs a question first.
preauthorize: false
covers: [voice-replacement, revoice, talking-face, lip-sync, fal-lipsync, paid-disclosure, asks-before-spending, mute-not-delete, update-overlay-fileid, standalone-audio-clip, one-audible-voice]
---

> **What this pins.** The talking-face branch of `voice-replacement` step 5, which `01` only
> touches through its lip-sync endpoint needle. Four things, in order: (1) the agent DISCLOSES
> the paid steps (hosted voice, lip-sync) and WAITS — nothing paid in the turns before the
> user's yes; (2) after the yes it voices the line and lip-syncs the clip on fal; (3) it swaps
> the overlay to the synced file in the skill's order: mute the original's inline clip
> (`libi.audio_clip` action `update`, `enabled: false` — never `remove`), point the overlay at
> the synced file (`libi.update_overlay` with `fileId`), add the synced file's own audio as a
> STANDALONE clip (`libi.audio_add_clip`, `kind` omitted or `"standalone"`, never `"inline"`);
> (4) it reads the composition back and says there is one audible voice.
>
> **"Exactly one audible voice" is a call-sequence check, not a pixel one.** The harness
> exposes the tool calls, not the final composition, so the invariant is: the inline clip is
> muted, the overlay moved to the synced file, the synced audio is added standalone, all after
> the lip-sync run, and the original inline clip is never removed. That is the layout the skill
> defines as one audible voice (muted original + one standalone clip). The agent's closing
> read-back (`libi.get_composition`) is a behavioural bullet below, for the judge to confirm.
>
> **The clip is a stand-in.** The only committed video with audio is `clip-red-3s.mp4` (a solid
> frame and a tone), so no real face is on screen: the user states in the prompt that she talks
> on camera and quotes the line. The skill classifies from "the analysis or the footage"; a run
> that looks at the frame and decides it is NOT a talking face is flagged under the behavioural
> bullets, not mechanically.
>
> **No `suggest_provider` here, on purpose.** The skill calls `libi.suggest_provider({ kind:
> "video", reason: "lip-sync" })` only when NO lip-sync model is in the agent's tools. This
> scenario connects the fake fal (`mcps: [elevenlabs, fal-ai]`), which carries
> `fal-ai/sync-lipsync/v2`, so the gate must stay closed; reaching for the card would be the
> bug. The no-lip-sync-provider branch needs its own scenario (`mcps: [elevenlabs]`).
>
> **Scripted yes.** Turn 1 asks, reply 1 answers the voice question WITHOUT a yes to spend
> (it says outright not to generate yet: an earlier wording, "a hosted voice is fine if it sounds
> better", read as consent to the hosted voice and it was generated in turn 2), reply 2 gives the yes.
> `creative_generate_speech` with `estimate_only: true` is free and is how the cost is disclosed, so
> the turn-1/2 absence needle excludes it. An agent that asks everything in turn 1 will ask once more in turn 2;
> one that spends after reply 1 fails the turn-[1,2] absence needles. The needles key on the
> rendered tool-call title (`[tool-call mcp__<server>__<tool>]`), and the `libi.*` merged-tool
> args render as compact JSON in the agent's own key order, hence the lookaheads.

## Prompt
Add {{fixture:clip-red-3s.mp4}} to this piece as a full-frame video. It is a clip of a woman
on camera, talking to the viewer. She says: "I have used this serum every morning for two
weeks." Replace her voice with a calmer female voice; she's on camera talking, so keep the
lips in sync.

## Replies
1. A new voice, not a clone: calm, warm, female. Pick the one you think sounds best, hosted or free, but don't generate or spend anything yet.
2. Yes, go ahead with both the voice and the lip-sync.

## Hard invariants
```yaml
assertions:
  # Nothing paid before the user's yes (turns 1-2): not the hosted voice, not a voice design, not the lip-sync.
  - { transcript_contains: ["[tool-call mcp__elevenlabs__creative_generate_in_flow]", "[tool-call mcp__elevenlabs__creative_design_voice]", "[tool-call mcp__fal-ai__run_model]", "[tool-call mcp__fal-ai__submit_job]"], turn: [1, 2], expect: absent }
  # …except that creative_generate_speech with `estimate_only: true` is the FREE price quote the skill's
  # ElevenLabs reference prescribes before the disclosure; only a call WITHOUT it is a spend.
  - { transcript_matches: '\[tool-call mcp__elevenlabs__creative_generate_speech\] (?![^\n]*"estimate_only":\s*true)', turn: [1, 2], expect: absent }
  # The paid steps were disclosed (cost named in the agent's own words) before the yes.
  - { transcript_contains: ["$", "cost", "credits", "billed", "charge", "price"], turn: [1, 2], scope: agent_text, expect: present }
  # After the yes: a voice was made (hosted, or the free local one) …
  #   (an `estimate_only: true` quote made a voice of nothing, so it does not count here either)
  - { transcript_matches: '\[tool-call mcp__elevenlabs__creative_generate_speech\] (?![^\n]*"estimate_only":\s*true)|\[tool-call mcp__elevenlabs__creative_generate_in_flow\]|\[tool-call mcp__libi__libi_generate_speech\]', turn: 3, expect: present }
  # … and the clip was lip-synced on fal (keyed on the endpoint, so a wrong model fails).
  - { endpoint_id: "fal-ai/*sync*", expect: present }
  # The provider gate stays closed: a lip-sync model is connected, so no card.
  - { transcript_contains: "[tool-call mcp__libi__libi_suggest_provider]", expect: absent }
  # Mute, never delete: the original inline clip is disabled …
  - { transcript_matches: '\[tool-call mcp__libi__libi_audio_clip\] \{(?=[^\n]*"action":\s*"update")(?=[^\n]*"enabled":\s*false)', expect: present }
  # … and no audio_clip remove is ever called.
  - { transcript_matches: '\[tool-call mcp__libi__libi_audio_clip\] \{[^\n]*"action":\s*"remove"', expect: absent }
  # The overlay is pointed at the synced file …
  - { transcript_matches: '\[tool-call mcp__libi__libi_update_overlay\] \{[^\n]*"fileId":\s*"', expect: present }
  # … and the synced file's audio goes on as a standalone clip (kind omitted defaults to standalone; inline is wrong).
  - { transcript_matches: '\[tool-call mcp__libi__libi_audio_add_clip\] \{', expect: present }
  - { transcript_matches: '\[tool-call mcp__libi__libi_audio_add_clip\] \{[^\n]*"kind":\s*"inline"', expect: absent }
  # ORDER, in the turn of the yes: the lip-sync run precedes the swap, and the mute precedes the overlay re-point.
  - { transcript_matches: '\[tool-call mcp__fal-ai__(?:run_model|submit_job)\][^\n]*(?:lipsync|latentsync)[\s\S]*\[tool-call mcp__libi__libi_update_overlay\] \{[^\n]*"fileId"', turn: 3, expect: present }
  - { transcript_matches: '\[tool-call mcp__libi__libi_audio_clip\] \{(?=[^\n]*"action":\s*"update")(?=[^\n]*"enabled":\s*false)[^\n]*\}[\s\S]*\[tool-call mcp__libi__libi_update_overlay\] \{[^\n]*"fileId"', turn: 3, expect: present }
  # The composition is read back after the swap (step 6: count the audible clips).
  - { transcript_matches: '\[tool-call mcp__libi__libi_update_overlay\] \{[^\n]*"fileId"[\s\S]*\[tool-call mcp__libi__libi_get_composition\]', turn: 3, expect: present }
```

## Behavioral expectations
- **Disclosed, then waited.** In turn 1 (or 2) said what it would generate (a new voice line, and a
  lip-sync pass on a hosted model) and roughly what each costs, asked whether to proceed, and ended the turn.
  Asked clone-or-new for the voice, and took "new, calm female" as the answer without re-asking.
- **Classified the clip as a talking face** from the user's statement and said lip-sync was needed;
  did not treat it as voice-only.
- **Sized the new line to the spoken text** (the quoted sentence, a few seconds), not a one-word
  paraphrase; named which voice it used.
- **Used fal's own upload tool** to put the clip and the new audio on the provider before the
  lip-sync call, and imported the result into the piece (`libi.upload_file`/`import_remote_files`),
  rather than inventing an upload.
- **The swap, in the skill's order**: muted the overlay's inline clip, pointed the overlay at the
  synced file, added the synced file's own audio as a standalone clip at the overlay's start
  (`startTime` the overlay's, `trimStart` 0 or its trim). The original file is still in the piece.
- **Read `libi.get_composition` back** and reported the final layout: muted original, the new
  segment's start and duration, lip-sync done, and exactly one enabled clip covering the overlay's
  window. Told the user the standalone clip does not move with the overlay.
- Did not read or ask for a provider key; did not claim the lips match if the lip-sync step failed.
