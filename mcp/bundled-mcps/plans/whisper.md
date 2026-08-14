# Install: Whisper (local STT)

Whisper is the **default** transcript provider. It is local and free — no
API key. Transcription runs inside libi via
`libi.analysis_transcribe_audio` (provider defaults to `whisper`). This
plan only ensures the model is downloaded.

## 1. Tell the user what's about to happen

Before any download step, tell the user (paraphrase, don't paste verbatim):

> "I'm about to set up local Whisper transcription. Here's what
> downloads to your machine:
> - **Python library**: `faster-whisper` 1.1.x from **PyPI**,
>   installed via the bundled `uv` (Apache-2.0).
> - **Model weights**: Systran's `faster-whisper-small` from
>   **HuggingFace** (`Systran/faster-whisper-small`, ~480 MB into
>   `~/.libi/models/whisper/`). Other sizes are tiny/base
>   (~80–150 MB), medium/large-v3 (1.5–3 GB).
> - **Cost**: free, on-device. No API key, no network calls during
>   transcription.
>
> OK to proceed with the `small` model?"

Wait for approval. If the user wants a different size, call
`libi.whisper_list_models` first so they can see the trade-offs before
choosing.

## 2. Confirm `uv` is present

Whisper runs faster-whisper through the bundled `uv`. Call
`libi.list_bundled_mcps` and check the `whisper` row's dependencies — `uv`
should be `installed` (it is a tier-1 dep installed at boot). If it is not,
something is wrong with the base install; tell the user.

## 3. Download the default model

After approval:

```
libi.whisper_download_model({ model: "small" })
```

This downloads the ~480 MB `small` model into `~/.libi/models/whisper/`
from HuggingFace (`Systran/faster-whisper-small`). It runs as a
background job with progress; it is idempotent (returns immediately if
already present).

## 4. Mark the row installed

After the download succeeds:

```
libi.update_dep_status({ mcpId: "whisper", status: "installed" })
```

## 5. Transcribe

```
libi.analysis_transcribe_audio({ fileId: "<id>" })
```

Provider defaults to `whisper`. Done.

## Larger models (optional)

If accuracy is poor, call `libi.whisper_list_models` to see options
(`tiny`, `base`, `small`, `medium`, `large-v3`). Suggest the next size up
to the user. **Only download `medium` or `large-v3` after the user
confirms** — they are 1.5 GB / 3 GB. Then:

```
libi.whisper_download_model({ model: "medium" })
libi.analysis_transcribe_audio({ fileId: "<id>", model: "medium" })
```

## Speaker diarization / audio events

faster-whisper does not label speakers and emits word tokens only. If the
user needs speaker labels or audio-event tags, use ElevenLabs instead:

```
libi.analysis_transcribe_audio({ fileId: "<id>", provider: "elevenlabs" })
```

(Requires the `elevenlabs` MCP configured with an API key.)

## Model size & updates

The Whisper model is small (~75 MB for `tiny`; larger sizes on request).
State the size before downloading. If `libi.list_bundled_mcps` later
shows the `whisper` model dep not installed after it was (a bumped model
version shipped in a libi update), tell the user and re-run
`libi.whisper_download_model` on approval.

---

## Env warm-up (optional pre-warm — informational)

This section is **informational, not a hard recovery step**. The
`libi.analysis_transcribe_audio` tool no longer gates on env-spec drift —
it will run regardless and pay the warm-up cost transparently on first
use after a version bump.

After a libi release that bumps a pinned Python dep (e.g.
`FASTER_WHISPER_VERSION`, `WHISPER_PYTHON_VERSION`), the FIRST call to
`libi.analysis_transcribe_audio` will pay an extra ~10–30s while `uv`
resolves the new spec. The model download is INDEPENDENT (see above).

If you want to pre-warm explicitly (e.g. to surface the cost up-front
before a batch run), open Settings → MCP Servers → Whisper and click
**Retry** on the env chip. Otherwise the warm-up happens transparently
on the next normal use, and the env install token is written on success.

### Disclosure (only if you choose to pre-warm proactively)

> "I can pre-warm the faster-whisper env to avoid a one-time ~30s delay
> on the next transcription. No new download — just `uv` materializing
> the pinned spec. Free, on-device, no API key. Want me to do it now,
> or just let the next transcription pay the cost?"

### Version drift

The env install token records a hash of the install spec (Python
version + pinned `--with` packages). After a libi release that bumps
those values, the first call pays the resolve cost once; subsequent
calls are hot-path.
