---
name: onboarding-libi-explainer-short
description: "Run ONLY during first-run onboarding when the user clicks \"show me how it works\" (or asks for the libi intro/demo). Builds libi's own 52-second explainer film into a real piece with a single call to libi.build_onboarding_piece (~15 MB download, no generation), reveals it, then tells the user honestly that the film is pre-made but was itself built in libi and is fully editable — and asks what they want to make."
when_to_use: "First-run onboarding demo only — the one place libi.build_onboarding_piece is ever called. Do not use for real user projects."
---

# Onboarding: libi explainer demo

A brand-new user's first look at libi. It is **one build call, then a conversation** —
you are not building anything here.

## Steps

1. **Say the wait out loud first.** Before you call anything, tell them you're pulling
   down libi's own explainer film — about **15 MB** the first time, a few seconds on a
   decent connection, and instant if this machine already has it. Setting the
   expectation before the wait is the whole reason this line exists; saying it
   afterwards is useless.

2. **Build it:** `libi.build_onboarding_piece({})` — no arguments. That single call
   downloads the media, verifies it, and assembles the whole composition. It returns a
   `pieceId` and a `description` of the film. Do **not** call any generation tool (no
   fal-ai, no ElevenLabs), do not import anything, and do not add or edit layers.

   If the result comes back `reused: true` / `bytes: 0`, this machine had already built
   the film and **nothing was downloaded on this call** — don't tell them it was.

3. **Reveal it:** `libi.show_piece({ pieceId })`.

4. **Close the conversation** with the message below.

## The film (so you can talk about it)

Don't describe it from here. The build result carries a `description` — runtime, beats,
layer counts, how the audio is mixed — derived from the film libi actually shipped in
this build. Read that and put it in your own words. Anything written in this file would
be a second copy that goes stale the day the film is recut.

## If the build fails

Most often the assets could not be fetched — offline, an unreachable bucket, a checksum
mismatch. But not every failure is a download, so do not diagnose one. When the call
errors:

- **Do not retry.** Not once, not "just in case", not with `force`. One call, one
  outcome. A brand-new user watching an agent spin is the worst first impression libi
  can make.
- Say in one sentence that libi could not fetch the demo film, and reassure them
  without claiming to know why — *"libi couldn't fetch the demo film, and it isn't
  something you did"* is true in every branch. Do not vouch for their install, do not
  blame their connection, do not name any cause you cannot see from here.
- Then go **straight** to asking what they want to make. A failed demo is not a dead
  end: everything in libi still works, and building their own thing is the better demo
  anyway. Do not offer to try the demo again unless they ask for it.

## Required closing message (transparency — do NOT skip)

Say this in chat, in your own warm voice, keeping every honest point:

- One honest note up front: this film is **pre-made**. You downloaded it — you did not
  generate it live just now.
- But it is not a canned marketing asset either: it was **built in libi**, by a coding
  agent, by asking for things and iterating — the same method they are about to use.
  The claim is about **how it was made, not about what their first result will look
  like.**
- In their own projects the footage is generated fresh rather than downloaded, which
  takes longer than this did and uses their credits. Say so plainly — it is the only
  time on the first-run path anyone mentions it.
- Same for the tracking shot — the green reticle locked to the sneaker is a **pre-made
  animation**, not tracking running on their machine just now. The original **was** made
  with libi's real object tracking; those boxes are where it put them. They can point it
  at their own footage whenever they like, and libi sets the tracking model up the first
  time they ask for it — no settings to find, it just takes a moment on first use.
- Every layer of it is **live and editable right now** — the scenes, the overlays, the
  voice-over, the music. Give one or two concrete things they could try immediately,
  e.g. *"change the end-card tagline to my product's name"* or *"turn the music down
  under the voice-over"*.
- End by asking **what they want to make first** (paste a product image or describe
  it), with no further text after the question.

Do not oversell: don't claim the film was generated live, don't present it as a preview
of their own first video, and don't imply anything they make will land this polished in
one shot.
