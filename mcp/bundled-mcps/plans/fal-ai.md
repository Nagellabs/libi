# Recovery guide: fal-ai MCP (HTTP)

fal-ai is an HTTP-based MCP — no install, no spawn. The whole setup
is collecting the user's API key.

> **Note:** claude-agent-acp doesn't yet pass HTTP MCPs through
> `newSession`. Even after a successful "install" via the steps below,
> tools won't appear in your deferred list for in-app ACP sessions.
> Setting the key still helps users who run libi via `npx @nagellabs/libi
> --connect-agent` (BYO-CLI mode) — Claude Code reads the same DB row
> and DOES support HTTP MCPs.

## Symptom: `inCurrentSession: false`, `whyExcluded: needs_config: FAL_KEY`

The MCP is excluded because `FAL_KEY` isn't set. Ask the user:

> "I need a fal.ai API key. You can create one at
> https://fal.ai/dashboard/keys. Heads up: fal-ai tools cost real
> money on each generation, billed to your fal.ai account. Paste the
> key here and I'll save it."

If the user pastes a key:

```
libi.update_dep_status({
  mcpId: "fal-ai",
  status: "installed",
  env: { FAL_KEY: "<the key>" }
})
```

Tell the user: "Saved. The fal-ai tools won't appear in this chat
session because of a current claude-agent-acp limitation with HTTP
MCPs — but BYO-CLI sessions will pick them up."

## Symptom: API key set but 401 / 403 from probe

The key is rejected. Same fix as ElevenLabs — ask user to re-check,
re-save, restart.
