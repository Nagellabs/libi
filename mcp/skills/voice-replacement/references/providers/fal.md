# fal — provider reference for `voice-replacement`

Lip-sync only. The decision flow (clone vs new, talking-face vs b-roll, coverage sizing)
is in `SKILL.md`. The shared call *discipline* — the `libi.sleep` polling cadence on a long
job, cost disclosure before the first paid call, import + `aiGeneration` provenance — is
`ai-asset-generation`'s `references/providers/fal.md`; only what lip-sync adds is below.

## Lip-sync

libi has no local lip-sync engine — the hosted model is the quality path.

- **Default: `fal-ai/sync-lipsync/v2`** (sync.so Lipsync 2 — studio-grade, frame-accurate).
- **Cheaper alternative: `fal-ai/latentsync`** (open-source).

Run it with `run_model` / `submit_job` on your fal MCP, passing the uploaded video URL +
audio URL. **PAID — disclose the cost (~$ per minute of video) and get approval first.**

Both inputs must be public `https` URLs: put the scene's video and the new VO audio on
fal's CDN with your fal MCP's own upload tool. NEVER read `FAL_KEY` or `curl` fal storage
yourself. If a remote fal MCP refuses the local path, say so and ask the user how to
proceed.
