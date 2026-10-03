# fal — provider reference for `video-analysis` (the paid script flow)

The paid full-video flow runs on the user's own fal MCP, never on libi: libi has no tool that
calls it. Whether a video-understanding model is available at all is the user's provider, so
check your tool list (and `libi.list_providers()`) first.

## The model

- **Default: `fal-ai/video-understanding`.** It takes a video URL and a prompt and answers in
  text; it hears the audio, so it can describe music, sound design and dialogue, and it sees
  the whole video at once (real shot boundaries). It does not return per-frame boxes or
  word-timed speech.
- It is a hint, not a promise: confirm it exists with `search_models`, read its inputs with
  `get_model_schema`, and price it per second of video with `get_pricing` before you disclose
  a cost. Bills the user's own fal credits.

## Running it

Put the video on fal's CDN with your fal MCP's own upload tool (never read `FAL_KEY` or push
bytes to fal storage yourself; if a remote MCP cannot read the local path, say so and ask).
Run with `run_model`, or `submit_job` + `check_job` for a long video, polling with
`libi.sleep` as `ai-asset-generation`'s `references/providers/fal.md` describes.

Ask for a production script: a shot list with camera, lighting, mood and dialogue per shot,
the music and sound design, overall style and pacing.

## Saving the result into libi

- **Production script** -> `libi.analysis_save({ action: "summary", fileId, summary })`, with the
  summary as a `video_v1` `VideoSummary` composed from the answer and the per-shot script
  text under `summary.custom.script`. `analysis_start` is not needed; the save is keyed by
  `fileId`.
- **Caption recreation spec** (the `mimic-video-captions` flow): ask instead for each
  caption's words, anchor (world or screen), motion keyframes with centre and
  height-fraction, reveal schedule, orientation, colour and glow, and save it with
  `libi.analysis_save({ action: "summary_custom", fileId, path: "caption_spec", value: <the spec> })`.
  That writes INTO the file's `summary` step, so one must exist first: run the free flow, or
  save a minimal summary with the required keys of `videoSummarySchema`:
  `{ schema_version: "video_v1", overview: "<one sentence>", duration: <seconds>, subjects: [], sections: [], recurring_objects: [] }`.

## What to add on top

The script has no boxes and no word timings, and the two coexist with it on the same file.
Run the free flow too when the downstream task is tracking or a character catalog (needs
`bbox`), and `audio-analysis` when it is word-level captions. Feeding shots to a
text-to-video model, or just reading what is in the video, needs only the script.
