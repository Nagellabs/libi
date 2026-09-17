# fal — provider reference for `removing-and-replacing-backgrounds`

The paid fallback endpoints. The local MatAnyone path (`libi.remove_background`), the
burned-in-graphics check, the magenta pixel verification and the compose/lineage steps are
in `SKILL.md` and apply whatever you use for the paid half. The call mechanics
(`run_model` / `submit_job` / `check_job`, the `libi.sleep` poll cadence, import +
provenance) are `ai-asset-generation`'s `references/providers/fal.md`; this file names only
what background removal needs.

## The paid endpoints

**Video:** `bria/video/background-removal/v3` (Bria V-RMBG 3.0) with
`{ video_url, background_color: "Transparent", output_container_and_codec: "webm_vp9" }`.
**Pass those two explicitly** — `background_color` defaults to `Black`, so omitting it
returns a black-matted video with NO alpha, and only the webm/mkv VP9 outputs can carry
alpha at all (any mp4/h264 variant silently drops it).

**Photo:** `fal-ai/birefnet` with `{ image_url }` (transparent PNG out).

### Two endpoints NOT to use

- Do NOT use `bria/video/background-removal` (the v1 id): it is a real endpoint but its
  worker crashes server-side on the transparent path (status reports COMPLETED, result
  fetch 500s) and it is priced ~33x above v3.
- Do NOT use `veed/video-background-removal` either — measured softer on both hair and
  subject edges at ~5x v3's price.

## Cost

Get the price via `get_pricing` for the endpoint and state it plainly; proceed only on
explicit user approval.

## Getting the source uploaded

Put the source on fal's CDN with your fal MCP's own upload tool, then pass the returned URL
as `video_url` / `image_url`. Never handle a provider key or upload bytes yourself. If a
remote fal MCP refuses the local path, say so and ask the user how to proceed.
