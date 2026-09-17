<!-- CANONICAL PROVIDER GATE. Inlined verbatim as the FIRST `## ` section of
     every generation skill, with <kind> replaced by that skill's ProviderKind.
     Pinned by __tests__/unit/skills/provider-gate.test.ts — edit here and
     re-run that test, which tells you every skill that drifted. -->

## Provider gate — read this first

You need a **<kind>** provider. libi generates no media itself.

1. **Check your tool list.** If you already have a provider that can do <kind>, use it.
   If this skill ships a reference for it — `references/providers/<id>.md` under this
   skill, where `<id>` is the provider's catalog id (`fal`, `elevenlabs`, `higgsfield`,
   `ace-step`, `kokoro`, `whisper`) — **read that file and follow it**. If there is no
   reference file for your provider, use the provider's own tool docs (its
   `get_model_schema` / `list_models` / equivalent) and keep to the capability and
   constraint rules in this skill. **libi's own extension tools count as a provider**
   for their kind — `libi.generate_music` (music), `libi.generate_speech` (voice),
   `libi.analysis_transcribe_audio` (transcription), `libi.remove_background` (matting,
   not generation). Prefer them by default: they are free and on-device. If one answers
   `needs_install`, follow its install flow (`libi.get_install_plan` / the download
   tools) instead of switching provider.
2. **If you have none** — no remote provider tool and no libi extension for <kind> — call
   `libi.suggest_provider({ kind: "<kind>" })`, tell the user what it showed, and
   **stop**. Do not improvise a provider, do not ask for an API key, and do not fall
   back to a tool that cannot do <kind>.
   If it answers `status: "none"`, there is nothing to connect: everything libi knows of
   for <kind> is already connected or already installed, and its `covered` list names it.
   Do not open anything or ask for a key — use what `covered` names, or, if that
   cannot do what was asked, say plainly what libi cannot do.

`libi.list_providers()` gives you the same picture without putting a card in the chat — use it
for a general "what's connected?". When the user asks about a provider that is not in your tool
list, call `libi.suggest_provider` instead, so the chat shows the buttons to connect it.
