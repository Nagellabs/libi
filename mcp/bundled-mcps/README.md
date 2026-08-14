# Bundled MCPs (Tier 2)

Optional MCP servers that libi suggests to the agent for specific user
intents (e.g. "use the YouTube downloader when the user asks to download
a YouTube video"). They are NOT installed at libi startup — the agent
installs them on demand via `libi.get_install_plan` and friends.

## Adding a new bundled MCP

1. **Write the install plan.** Create `plans/<id>.md` with platform-specific
   install steps. The agent reads this verbatim, so write it for an LLM:
   numbered steps, exact commands, success checks. See `plans/yt-dlp.md`
   as the canonical example.
2. **Register it.** Add an entry to `registry.ts` with `installFlow:
   "tier-2"` and `installPlanPath: "mcp/bundled-mcps/plans/<id>.md"`.
3. **Tell the agent when to use it.** Add a one-line trigger to
   `mcp/instructions.ts` ("If the user asks to X, the bundled MCP `<id>`
   handles it"). The agent will check `libi.list_bundled_mcps`, see it
   isn't installed, and install on demand.

That's it. No install code lives in this directory — the agent owns the
install loop. Your job is to author clear instructions for the agent.

## NOT for libi's own binary deps

Things libi tools call directly (ffmpeg, ffprobe, Chromium for export,
mediapipe-vision for tracking) are Tier 1: they belong in
`mcp/registry/core.ts` and are installed by Category A. Adding them
here would let the agent skip installing them, and then libi's own
tools would fail at runtime.

Rule of thumb: if removing it breaks `libi.create_scene`, it's Tier 1.
If it only breaks a specific bundled MCP, it's Tier 2.
