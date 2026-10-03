# elevenlabs — provider reference for `ai-asset-generation`

Read this when your `voice` / `music` / `sfx` provider is ElevenLabs: the user's own
ElevenLabs MCP, their hosted server, signed in with their ElevenLabs account. libi does not
bundle or configure it, and there is no key. This file is how its tools are called; the other
skills' ElevenLabs references point here. The import/provenance mechanics stay in `SKILL.md`.

## How its tools work

- Every creative tool is a **flow run**. A generate call returns `flow_id`, `node_id` and
  `session_ids`, never the audio.
- Every call takes a required **`context`**: one short line on why ("voiceover for the
  product ad"). Never a key, never the user's personal details.
- **Always pass `generations_count: 1`.** The default is 4: four takes, four times the
  credits. Make more only when the user asks for takes to choose from.
- **Voices** come from `creative_list_voices` (search, gender, age, languages, use_cases) or
  from the user. Never invent a `voice_id`. Each voice's gender, accent, age and language are
  under its `labels`, and its `name` carries a tagline ("Bella - Professional, Bright, Warm").
- **Speech**: `creative_generate_speech({ prompt: <the exact text>, voice_id, model_id,
  generations_count: 1, context })`. `eleven_multilingual_v2` is the default model;
  `eleven_v3` takes audio tags such as `[whispering]`.
- **Music, sound effects, voice changer, voice isolation**: `creative_generate_in_flow` with
  `node_type` `music` / `sfx` / `voice-changer` / `voice-isolator` and a model of that type.
  `creative_get_flow_node_types` lists the models (e.g. `eleven_music_v2`,
  `eleven_text_to_sound_v2`); `creative_get_model_schema` gives a model's parameters.
- Never call its `agents_*` tools (conversational phone and chat agents), and don't use it for
  images or video here.

## Cost: price it, say it, wait for a yes

Before every paid run, make the same call with `estimate_only: true` (and the same
`generations_count: 1`). It returns `estimate.credits` — the price in the user's ElevenLabs
credits, which can be fractional — and charges nothing (it does create a flow on their
account). Tell the user that number, wait for a yes, then make the call without
`estimate_only`.

## Getting the result

Poll `creative_get_flow_run_status({ flow_id, session_ids: <all of them>, context })`. While
`all_completed` is false, wait `poll_after_seconds` with `libi.sleep`, then poll again. On
`has_failures`, show the error verbatim and ask how to proceed. When it is done, the audio
is in `media[]`: each entry's `url` (an mp3), matched to its generation by `generation_id`.
The entries in `generations[]` carry the status and `price.credits`, never a URL.
**The URL is short-lived: download it right away**, as the import section of SKILL.md says for a URL (to a
temp path, then `libi.upload_file` with `aiGeneration`). A transcription's result is in
`transcripts[]` instead: `text` is flat text only, with no per-word timing and no speaker
labels.

## Sending it a local file

Needed for the voice changer, voice isolation and transcription. Call `creative_create_flow`
first. Then `creative_create_asset_upload({ name, mime_type, file_size: <exact bytes>,
context })`, and PUT the file's bytes to its `upload_url` with `Content-Type` exactly
`mime_type`:
`curl -sf -X PUT -H "Content-Type: audio/wav" --data-binary @<file> "<upload_url>"`.
A file over the result's `max_file_size_bytes` (200 MiB) is refused.
Then `creative_finalize_asset_upload({ asset_id, flow_id, context })` places it on the flow.
Pass its `node_id` in `connect_from`, with the same `flow_id`.

## Provenance

In the `aiGeneration` block, set `provider: "elevenlabs"`, `model` to the `model_id`, and
`providerJobId` to the session id. Set `costEstimate` to `{ amount: <credits>, currency:
"credits", tier: <model_id> }`, using the generation's `price.credits` from the poll (or the
estimate's `credits`).

## An older local server

If your tool list has `text_to_speech`, `compose_music` and similar tools instead of
`creative_*`, the user runs the older local server. Use those tools per their own
descriptions, and follow the same cost rule.
