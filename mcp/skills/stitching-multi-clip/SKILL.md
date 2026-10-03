---
name: stitching-multi-clip
description: "Any timeline with more than one independently generated video clip: one video overlay per beat, seams smoothed by the editor, joining into one file left to export. Not for a single source, an extend chain ending in one file, or a restyle of one source."
---

# Stitching Multi-Clip

Done looks like: a timeline that plays as one continuous, believable video, where every beat is its own video overlay, any reused source footage shows no face or body that clashes with the new character, one voice runs through the whole piece, and the seams read as natural cuts.

This skill is reference for the creation skills (`ugc-product-video`, `generic-video`) when a piece mixes independently produced clips: reused source footage trimmed into beats, plus AI beats around it. It does not apply to a single continuous source, an extend chain that returns one file, or a restyle of one source: those are already one clip.

## One full-frame video overlay per beat

Keep every clip as its own video overlay, laid end to end in playback order. The editor smooths clip-boundary seams on its own, so there is no glitch to work around and no reason to concatenate. Joining the clips into one file destroys per-beat editing (re-rolling one beat, trimming one clip, swapping its audio); joining is a final-export concern, handled by the export pipeline. If the user wants one flattened file as a deliverable, `libi.concat_videos` with the ordered `fileIds` makes a separate asset and never replaces the timeline.

Under the storyboard (the default for creation skills) each beat is a card: an AI beat is a card whose take is the generated clip (`libi.storyboard_take` action `attach_clip`, then `libi.storyboard_take` action `select`), a re-roll is a new take on the same card, and a reused beat is a card whose take is the source clip, then trimmed on its overlay. Without a storyboard, add one `libi.add_overlay({ kind: "video", fileId, startTime })` per beat, `startTime` at the cumulative end of the beats before it, omitting `rect` (full frame) and `duration` (read from the file). Either way the beats stay separate layers.

Pick as few, as long beats as tell the story. Each AI insert defaults to the longest clip the chosen model allows, with its beats as jump cuts inside the prompt, and a reused trim spans the whole continuous stretch worth keeping: a stitch is multi-clip because it has separate sources, not because it should be chopped into many short ones.

## Partition the source: replace the surrounding, reuse the demo

A stitch is usually a variation job: the user has a source ad and wants more versions (a new character, the same character with new speech, a new hook). Partition the source by identity:

- **Replace with new AI** the character-driven surrounding: the talking-head hook, the on-camera presenter, the spoken script.
- **Reuse from the source** the product-demonstration stretches that show the product in use, are identity-neutral (hands only, product only, no recognizable face) and are physically real. This footage is the costly-to-fake realism, so keep it.
- **Keep the creator instead**: when the user says "keep me in it", invert it. Reuse every on-camera moment and limit AI beats to faceless inserts (product close-ups, b-roll, hands, transitions). Never generate someone to stand in for the real creator.

Run the partition after analysis and before any generation, and get the plan approved, so the script is right before credits are spent. If the source has no identity-neutral, replicable demo to cut (it is all the creator's face), stop and work out the strategy with the user: a full recreation without reuse, a crop or reframe of a partly usable moment, or an explicit trade-off. Never force a bad partition silently.

## The reused footage must not leak the old face, and must match the new body

The new character and the reused clips are presented as the same person. Read the analysis (keyframes and summary) of every reused segment and inventory what is visible before you generate anything.

**Faces.** A reused beat that shows the replaced creator's identifiable face, even for a few frames, is a defect: the viewer sees the old person reappear. Analysis keyframes are sparse (every 2 to 3 seconds), so the real first and last frames of a trim fall in an unanalyzed gap where the creator often sits. So for every reused segment:

1. Extract fresh frames at a fine step (0.5 s or less) across the first and last 1.5 s of its window with `libi.analysis_extract({ action: "frames", fileId, timestamps })`, and view each one.
2. If a face or a body part you are not matching appears, move that edge inward and extract the new edge again until it is clean. If the product moment cannot be kept without the face, drop that stretch or regenerate it.
3. Write the trim with `libi.update_overlay({ overlayId, trim: { start, end } })`, then read the overlay's committed `trim` from `libi.get_composition` and extract frames at those committed edges, not at the numbers you planned. The check passes when a frame at the committed edge is clean.

**Body parts.** Hands, arms, skin and hair in reused footage are the new character's body in the ad's fiction, so the AI character must match them: skin tone above all, then apparent age, build, gender and distinctive features. A creator of one skin tone over reused hands of another is a hard failure. When an AI clip continues a specific reused body part (the same hand finishing an action), pass that reused frame as a reference image so it matches; when the match only needs to be general, put the attributes in the prompt.

Raise this when you first ask what the new creator should look like, and lead with the constraint: "the reused demo shows light-tan hands, so the new creator should be a similar skin tone, or we also regenerate the hand beats." If the user asks for a look that clashes, push back and offer a matching tone, regenerating the affected beats at extra cost, or accepting the mismatch. Never silently generate a clashing character: the reused footage constrains the character, not the reverse.

## Voice

Ask the user first: reuse the voice from the source, or give the new creator a fresh voice, and explain that a reused beat which already carries the creator's voiceover is the cheapest, most consistent spine. The mechanism (native audio on every AI clip, the reference-conditioned carry, MP3 or WAV samples, matching the source speaker's delivery in the prompt, no two voices on one clip, no silent inserts) is owned by the stitching section of `video-generation-craft`'s `references/voice.md`: read it before you draft any beat's audio, and treat a voice plan written without it as provisional. A different or cloned voice is the separate `voice-replacement` skill, started by the user.

One thing is specific to a stitch and lives here: **the bookend lines must dovetail with the reused middle's real transcript, and the trims must fall on clause boundaries.** Pull the reuse window's transcript, then:

- The hook line hands off into the reuse's opening and must not end on the sentence the reuse opens with (the viewer would hear it twice).
- The reuse trim starts and ends at natural sentence or clause boundaries, never mid-word.
- The verdict line picks up from the reuse's closing words and bridges any jump in time or topic ("two weeks later...").

So each seam trim satisfies two constraints at once: a face-free edge and a clean spoken edge.

## Verify, then the director's review

Before commit, read the composition back and check that the beat count and order match the plan, each beat points at its own clip (no single collapsed overlay), the audio shape matches the voice plan, and the reused trims were re-verified at their committed edges (above). The calling skill's verify gate runs this.

Then review the assembled piece as a viewer, not as the builder. The agent that built it is anchored to its plan and rates its own seams generously, so use a fresh pass, ideally a subagent, given only the full spoken script in timeline order, the ordered beat list with durations, and a frame from each side of every seam. The question is one: watching it straight through, does it read as one continuous, genuine video? It must catch a line repeated at a seam, a seam that cuts a thought off, an unmotivated jump in time or topic, an energy whiplash, and a seam that changes subject too fast to follow.

When it finds a break, fix it with the cheapest tool that works: re-time the trim to a clean clause boundary (free), rewrite a bookend line and re-roll only that clip, or add a short connective beat. Then review again. A stitch that is technically clean but narratively choppy is not done.

## Re-rolling one beat

A bad beat is fixed in place. Generate that one clip again with a corrected prompt, attach it as a new take and select it (without a storyboard, point the layer at the new file with `libi.update_overlay({ overlayId, fileId })`). The other beats are untouched, and nothing needs to be rebuilt.

## Making a beat longer or shorter later

Never retime a built piece layer by layer: moving every later overlay and clip is one call.

- **Longer.** `libi.clip({ action: "insert_time", pieceId, at, seconds, extendTarget })` with `at` the end of the beat and `extendTarget` its video overlay: everything after `at` moves right, full-length layers (a background, the music bed) grow to still cover the piece, and the beat's trim and audio grow with it. A video can only run as long as its file: with no footage left the call is refused and says how much there is, so insert at most that or generate a longer take. The result lists what moved and `leftSpanning`; the manual's audio-clips section has the rest (`stretch`, warnings).
- **Shorter.** `libi.clip` action `delete` with `ripple: true` closes a gap, and `libi.update_overlay` with a shorter `duration` trims a beat.
- **Several pieces.** The same retime on every copy is one `libi.apply_ops` op (`{ op: "clip", action: "insert_time", at, seconds, extendTarget }`) over the folder, not one call per piece.
- Code overlays that hard-code a composition time (an offset, a list of cut times) do not follow a retime: read the time from the draw context instead (`context.compositionTime`, `overlayStart`) or fix the constant.
