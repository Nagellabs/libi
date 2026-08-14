<!-- mcp/bundled-mcps/plans/local-tts.md -->
# Install: Local TTS (Kokoro)

Local TTS is the **default** speech provider. It is local and free — no
API key. Synthesis runs inside libi via `libi.generate_speech`. This plan
only ensures the Kokoro model is downloaded.

## 1. Tell the user what's about to happen

Before any download step, tell the user (paraphrase, don't paste verbatim):

> "I'm about to set up local Kokoro text-to-speech. Here's what
> downloads to your machine:
> - **Python library**: `kokoro-onnx` 0.4.x from **PyPI**,
>   installed via the bundled `uv` (Apache-2.0).
> - **Model + voice bank**: int8-quantized ONNX model and voice
>   embeddings from the upstream Kokoro release (~110 MB total into
>   `~/.libi/models/tts/kokoro/`).
> - **Cost**: free, on-device. No API key, no network calls during
>   synthesis.
>
> OK to proceed?"

Wait for approval before running step 3.

## 2. Confirm `uv` is present

Local TTS runs kokoro-onnx through the bundled `uv`. Call
`libi.list_bundled_mcps` and check the `local-tts` row's dependencies — `uv`
should be `installed` (tier-1, installed at boot). If it is not, something
is wrong with the base install; tell the user.

## 3. Download the model

After approval:

```
libi.tts_download_model()
```

This downloads the quantized Kokoro model + voice bank (~110 MB total) into
`~/.libi/models/tts/kokoro/`. It runs as a background job with progress and
is idempotent (returns immediately if already present).

## 4. Mark the row installed

After the download succeeds:

```
libi.update_dep_status({ mcpId: "local-tts", status: "installed" })
```

## 5. Generate speech

```
libi.generate_speech({ text: "Welcome to Libi" })
```

Voice defaults to `af_heart`. Use `libi.tts_list_voices` to pick another
voice, and pass `withTimestamps: true` if you need per-word timings to build
caption/timeline overlays.

## Voice cloning / branded voices

Kokoro is fixed-voice (no cloning). If the user needs a specific cloned or
branded voice, use ElevenLabs instead:

```
(elevenlabs MCP) text_to_speech(...)
```

(Requires the `elevenlabs` MCP configured with an API key; it is paid and
approval-gated.)

## Model size & updates

The Kokoro model is ~110 MB. State the size before downloading. If
`libi.list_bundled_mcps` later shows the `local-tts` model dep not
installed after it was (a bumped model version shipped in a libi
update), tell the user and re-run `libi.tts_download_model` on approval.

---

## Env warm-up (optional pre-warm — informational)

This section is **informational, not a hard recovery step**. The
`libi.generate_speech` tool no longer gates on env-spec drift — it will
run regardless and pay the warm-up cost transparently on first use
after a version bump.

After a libi release that bumps a pinned Python dep (e.g.
`KOKORO_ONNX_VERSION`, `TTS_PYTHON_VERSION`), the FIRST call to
`libi.generate_speech` will pay an extra ~10–30s while `uv` resolves
the new spec. The model download is INDEPENDENT (see above).

If you want to pre-warm explicitly, open Settings → MCP Servers →
Local TTS and click **Retry** on the env chip. Otherwise the warm-up
happens transparently on the next normal use, and the env install
token is written on success.

### Disclosure (only if you choose to pre-warm proactively)

> "I can pre-warm the kokoro-onnx env to avoid a one-time ~30s delay
> on the next synthesis. No new download — just `uv` materializing the
> pinned spec. Free, on-device, no API key. Want me to do it now, or
> just let the next call pay the cost?"

### Version drift

The env install token records a hash of the install spec (Python
version + pinned `--with` packages). After a libi release that bumps
those values, the first call pays the resolve cost once; subsequent
calls are hot-path.
