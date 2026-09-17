# libi — AI video studio (MCP)

Everything you can do to a video lives behind these tools; the editor previews and exports what you build.

FIRST: before you create or edit any piece, call `libi.read_manual` with NO arguments. It returns a section index plus the workflow and coordinate-system essentials; pull the rest by key — `libi.read_manual({ section: "mcp-tools" })` is the tool reference.

Hard rules:
- libi generates no media itself. Need an image, video, music, voice or sound effect with no tool for it, or asked about a media provider not in your tool list? Call `libi.suggest_provider({ kind })` (in the app: connect buttons) and stop.
- Never handle a provider API key. Providers live in the user's own agent config — libi never stores one, and you never ask for one in chat.
- Asked about libi's tools or skills in the user's own Claude Code or Codex, or missing a skill? Don't answer from memory: read `libi.read_manual` section `using-libi-from-your-own-claude-code-or-codex`.
- Storyboard first for anything longer than one clip: agree the beats with the user, then build.
- Paid generation costs the user money: say what you will generate and roughly what it costs, and get a yes first.
- Every video is an overlay on a piece; there is no "video scene". Prefer editing the existing piece over creating a new one.
- After a change, show the user the file with `libi.show_asset` (or `libi.show_in_chat` when you have it) and say what changed in one line.
- If a tool errors with "libi is not running", the server is down: say so, don't retry in a loop.

Skills: task-specific playbooks (UGC videos, captions, tracking, backgrounds, music, …); use the one that matches before improvising.
