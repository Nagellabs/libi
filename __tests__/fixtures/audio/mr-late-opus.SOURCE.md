# mr-late-opus.webm

A browser recording made with Chrome's `MediaRecorder` (`video/webm;codecs=vp8,opus`) in
Electron 36, from synthetic sources only: a 64×36 canvas cycling hues (the video, from the
recorder's start) and a 200 → 1800 Hz oscillator sweep started 300 ms later (the audio).
So the VP8 track starts at 0 and the Opus track at 0.348 s, with pre-skip 0 and 60 ms
frames whose timestamps jitter by ±2 ms, as MediaRecorder writes them. No third-party
material.

It pins review round 3's R3-C1: an Opus track that starts after its file
(`__tests__/integration/opus-ogg-placement.test.ts`). Made by `rec.html` + `main.js` in the
session scratchpad (`mb4/rec/`), recorded 2026-09-26.
