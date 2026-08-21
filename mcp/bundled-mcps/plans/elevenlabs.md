# Recovery guide: ElevenLabs MCP (`elevenlabs-mcp`)

This MCP runs via `uv tool run elevenlabs-mcp` by default. The only
thing it needs from the user is an API key.

## Symptom: `inCurrentSession: false`, `whyExcluded: needs_config: ELEVENLABS_API_KEY`

The MCP is excluded from your session because `ELEVENLABS_API_KEY`
isn't set. Ask the user, in plain English:

> "I need an ElevenLabs API key to set this up. You can create one at
> https://elevenlabs.io/app/settings/api-keys. Your key stays on your
> machine. Paste it here and I'll continue."

If the user pastes a key, save it:

```
libi.update_dep_status({
  mcpId: "elevenlabs",
  status: "installed",
  env: { ELEVENLABS_API_KEY: "<the key>" }
})
```

Then call `libi.restart_mcp_server({ mcpId: "elevenlabs" })`. The MCP
will pick up the new env var and become available in your next message.

If the user declines, leave the MCP in `needs_config` and just tell
them the feature isn't available.

## Symptom: API key set but `lastServerError` mentions 401

The user's key was rejected (expired, malformed, account suspended).
Ask the user to re-check their key, then re-save with `update_dep_status`
and restart.

## Symptom: `auxiliary` shows uv-related errors

`uv` is missing from `~/.libi/bin/`. Libi's Category A normally
installs it. Suggest the user restart libi or check their boot logs.
Don't try to reinstall uv from this MCP's recovery path — it's a libi
infrastructure problem.
