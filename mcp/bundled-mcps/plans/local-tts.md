<!-- mcp/bundled-mcps/plans/local-tts.md -->
# Install: Local TTS (Kokoro)

Local TTS is the **default** speech provider. It is local and free — no
API key. Synthesis runs inside libi via `libi.generate_speech`. This plan
only ensures the Kokoro model is downloaded.

**What a synthesized track is NOT for.** It is a *standalone* spoken track —
narration over b-roll, an explicit "add a voiceover" request. It is never the
native audio of a video generation: an AI clip speaks because it was generated
with `generate_audio: true`, and one voice across several clips comes from a
reference-conditioned generation, not from a TTS track laid over the top. See
the `voiceover-production` skill before you synthesize anything for a generated
video, and the `voice-replacement` skill for deliberately changing the voice on
a video that already exists. Installing this extension is not a reason to use it.

## 1. Tell the user what's about to happen

Before any download step, tell the user (paraphrase, don't paste verbatim):

> "I'm about to set up local Kokoro text-to-speech. Here's what
> downloads to your machine:
> - **Python library**: `kokoro-onnx` 0.4.x from **PyPI**,
>   installed via the bundled `uv` (Apache-2.0).
> - **Model + voice bank**: int8-quantized ONNX model and voice
>   embeddings from the upstream Kokoro release (~121 MB total into
>   `~/.libi/models/tts/kokoro/`).
> - **Cost**: free, on-device. No API key, no network calls during
>   synthesis.
>
> OK to proceed?"

Wait for approval before running step 3.

## 2. Confirm `uv` is present

Local TTS runs kokoro-onnx through libi's own `uv`. It is a dependency of this
extension (not part of the base install), so it may not be on disk yet. The
`libi.get_install_plan({ mcpId: "local-tts" })` result that gave you this plan
carries a `dependencies` array — find the entry with `binary: "uv"`:

- `installed: true` — carry on to step 3.
- `installed: false` — libi downloads it from the Agents → Libi MCP
  tab: call `libi.show_extension({ extensionId: "local-tts" })` and ask the user to
  press **Download** next to `uv` on that card, then re-run
  `libi.get_install_plan` to confirm before continuing. Do not try to install
  `uv` yourself, and do not go on to step 3 without it — the model download
  runs through `uv` and fails without it.
- `dependenciesError` set — the readout itself failed; tell the user what it
  says rather than guessing.

## 3. Download the model

After approval:

```
libi.tts_download_model()
```

This downloads the quantized Kokoro model + voice bank (~121 MB total) into
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

Kokoro is fixed-voice (no cloning). A cloned or branded voice needs a `voice`
provider that offers one, on an MCP the user has connected themselves — libi
bundles none and configures none. If one is already in your tool list, the
owning skill's `references/providers/<id>.md` says what it buys and how it
bills; it is paid and approval-gated. If none is, say so rather than going
shopping on the user's behalf.

## Model size & updates

The Kokoro model is ~121 MB. State the size before downloading. If the
Agents → Libi MCP tab later shows the `local-tts` model dep
not installed after it was (a bumped model version shipped in a libi
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

If you want to pre-warm explicitly, open Agents → Libi MCP →
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
