---
id: boot-and-mcp-discovery
title: Terminal session boots the CLI agent and it discovers the libi MCP
surfaces: [terminal, connect-agent]
agents: [claude-code, codex]
systems: [pty-spawn, workspace-config, mcp-stdio-handshake]
cost: subscription-tokens
---

## Surface notes
- On `connect-agent`: replace the PTY/terminal steps (1–2) with — verify the
  connected dir's config files (`.mcp.json`, `.claude/settings.local.json`,
  CLAUDE.md marker section, skills mirror + `.libi-managed.json`, decoy files
  intact), then launch `claude` in the scratch dir via tmux and answer the
  first-run trust/MCP prompts.

## Preconditions
- libi dev server running (`npm run dev`), app open in browser.
- Sidebar agent selector → **Terminal**, CLI preset = **Claude Code**.

## Steps
1. Click **New terminal**. A PTY opens; the shell prompt appears; `claude` is
   typed into the shell automatically and launches.
2. Answer the directory-trust prompt if shown (trust `~/.libi/agent/`).
3. In Claude Code, run `/mcp` (or prompt: *"List the MCP servers and tools you
   have available. Just the names."*).

## Expected behavior
- The shell starts in `~/.libi/agent/` (login shell, user PATH resolved).
- Claude Code finds `.claude/settings.local.json` and connects the `libi`
  MCP server (plus enabled bundled MCPs, e.g. YouTube Downloader).

## Checks
- [ ] Terminal opens and `claude` launches (no `posix_spawnp` / PATH errors).
- [ ] `/mcp` lists a connected `libi` server.
- [ ] `libi.*` tools are visible (e.g. `libi.list_pieces`, `libi.create_piece`).
- [ ] Bundled MCP (YouTube Downloader) appears in the server list.
- [ ] Ask the agent to call `libi.get_version` — returns the libi version
      (proves a live stdio round-trip, not just config parsing).
- [ ] Ask the agent to call `libi.list_bundled_mcps` — returns install/config
      status for the bundled set (secrets redacted).

## Notes
- Codex variant: discovery is also via the settings file; tool-listing UX
  differs (`/mcp` equivalent or a prompt).
- If `libi` is missing entirely: check `~/.libi/agent/.claude/settings.local.json`
  exists and `lib/mcp-config.ts` wrote it on boot (`tag: "mcp-config"` in
  `~/.libi/logs/libi.log`).
