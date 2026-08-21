<!-- mcp/bundled-mcps/plans/local-music.md -->
# Install: Local Music (ACE-Step)

Local music is the **default** music provider. It is local and free — no
API key. Generation runs inside libi via `libi.generate_music`. This plan
ensures the ACE-Step library + model are installed.

## 1. Tell the user what's about to happen

Before any download step, tell the user (paraphrase, don't paste verbatim):

> "I'm about to set up local ACE-Step music generation. This one is
> chunkier than the others — please look it over before approving:
> - **Python library**: `ace-step` installed via the bundled `uv`
>   from **GitHub** at a pinned commit (`github.com/ace-step/ACE-Step`,
>   Apache-2.0). We use a git pin because the PyPI release is currently
>   broken upstream. The pinned SHA is in
>   `lib/music/models.ts:ACESTEP_GIT_SHA`.
> - **Transitive deps**: torch, diffusers, spacy, transformers, etc.
>   The first install will pull ~2 GB of Python wheels into uv's cache.
> - **Model weights**: ACE-Step's `v1-3.5B` checkpoint from
>   **HuggingFace** (`ACE-Step/ACE-Step-v1-3.5B`, ~8.3 GB into
>   `~/.libi/models/ace-step/`).
> - **Cost**: free, on-device. No API key. Generation is CPU-heavy
>   though — ~3–5 minutes per 10 s of audio on a typical Mac.
>
> OK to proceed? Total disk hit is ~7–8 GB on first install."

Wait for explicit approval before any download step.

## 2. Confirm `uv` is present

Local music runs ACE-Step through the bundled `uv`. Call
`libi.list_bundled_mcps` and check the `local-music` row's dependencies —
`uv` should be `installed` (tier-1, installed at boot). If not, something
is wrong with the base install; tell the user.

## 3. Download the model

After approval:

```
libi.music_download_model()
```

Downloads ACE-Step (~8.3 GB) from HuggingFace into
`~/.libi/models/ace-step/`, plus installs the `ace-step` Python library
from the pinned GitHub commit on first run. Background job with progress
in chat; idempotent (returns immediately if already present and the
version matches). If files are corrupt/partial, call
`libi.music_download_model({ force: true })` to re-fetch.

## 4. Mark the row installed

After the download succeeds:

```
libi.update_dep_status({ mcpId: "local-music", status: "installed" })
```

## 5. Tell the user the generation cost — every time

Generation is not just slow, it is **memory-heavy**: the 3.5B-param
pipeline takes ~9 GB resident, ~12 GB peak during inference (at the
default bf16/fp16 dtype). Before each `libi.generate_music` call,
tell the user (paraphrase):

> "Heads up: generating ~30 s of music will use ~12 GB of RAM for a
> few minutes and take roughly N seconds on this machine (see the
> `confirm_duration` estimate). It runs entirely on-device. OK to
> proceed?"

Use the estimate returned by `confirm_duration` for N. This goes on
top of the install-time disclosure — installation is one-time, but
every generation re-spawns the pipeline, so the RAM cost recurs.

If the tool returns `status: "insufficient_memory"`, the host doesn't
have enough free RAM right now. Tell the user, suggest they close some
apps, then offer to retry — don't just spin.

## 6. Generate music

```
libi.generate_music({ prompt: "calm lofi piano, gentle, looping" })
```

Duration defaults to ~30s. Possible failure statuses:
- `confirm_duration` → tell the user the estimated time and re-call
  with `confirm: true`.
- `insufficient_memory` → see step 5; do not retry without user
  acknowledgement of the RAM situation.
- `model_load_failed` → corrupt/partial weights; call
  `libi.music_download_model({ force: true })` then retry.

Pass `lyrics` for vocals or `instrumental: true` for a bed. The result
is a stored audio file — add it to the composition with
`libi.add_audio_track`.

## 7. Model updates

If `libi.list_bundled_mcps` later shows the `ace-step` model dep as not
installed even though it was (a newer pinned model version shipped in a
libi update), tell the user a newer model is available (~8.3 GB) and, on
approval, re-run `libi.music_download_model()`.

## Paid / licensed music

Use paid providers or user-supplied licensed tracks only when the user
explicitly asks. Local ACE-Step is the default.

---

## Section B — Analysis (`libi.music_detect_beats`, `libi.music_profile`)

Only run this section when a music analysis tool returned
`{ status: "needs_install" }` — Section A's ACE-Step weights are
INDEPENDENT and have their own gate.

### Disclosure (paraphrase to the user before running)

> "I need to set up the local music analysis env. Smaller than the
> generation one:
>
> - **Python lib**: `librosa==0.11.0` from PyPI (ISC license)
> - **Disk hit**: ~50 MB of pure-Python wheels into uv's cache
> - **Time**: first call materializes via uv (~10s); subsequent calls ~1s
> - **Cost**: free, on-device, no API key
>
> OK to proceed?"

Wait for explicit approval.

### Steps

1. `libi.music_install_analysis_deps()` — runs once, writes the install
   token. Idempotent.
2. `libi.update_dep_status({ mcpId: "local-music", status: "installed" })`
3. Retry the original tool (`libi.music_detect_beats` or
   `libi.music_profile`).

### Version drift

The install token records a hash of the install spec (Python version +
all pinned `--with` packages). If a future libi release bumps
`LIBROSA_VERSION` or adds a new dep, your next call will surface this
section again — that's expected and one-shot.
