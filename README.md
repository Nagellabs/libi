# libi

**An AI video studio for coding agents.**

libi treats video as code. Every frame is a JavaScript function drawing to a canvas, so an
AI coding agent — the most capable form of AI available today — can write, edit and refine
a video the same way it writes software. You describe what you want in chat; the agent
builds the scenes, generates or imports the assets, adds voiceover and music, and you watch
it come together in a live preview.

- **Chat with Claude Code or Codex.** libi drives them over ACP and hands them video tools over MCP.
- **Canvas scenes + layered overlays** — text, images, video, code and 3D, each with its own timing, position and z-order.
- **Real editing tools** — timeline, audio mixer with ducking, object tracking, background removal, video analysis.
- **Bring any MCP server.** Generate clips, voiceover, music or sound effects through fal.ai, ElevenLabs, YouTube download, or anything you connect yourself.
- **Fast exports.** A trim is a stream copy; overlays composite in a single ffmpeg pass; anything else renders through WebCodecs.
- **Local-first.** Your media, database and generated assets stay on your machine in `~/.libi/`.

> **libi is in beta.** It moves fast and has rough edges. Please tell us about the ones you hit.

---

## Requirements

- **Node.js 20.9+** (only for the npm package — the desktop app bundles its own runtime)
- **A CLI coding agent you're already signed in to** — [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex). libi installs the adapters it needs; you bring the account.
- **~1 GB of free disk** for what libi downloads on first run (ffmpeg/ffprobe, a Chromium for rendering, the agent adapter). Object tracking and background removal pull their models on demand, later.
- **macOS** — where libi is built and tested today. Windows and Linux support is coming.

## Run libi

### Desktop app

Download the macOS build (`.dmg` or `.zip`) from the
[Releases page](https://github.com/Nagellabs/libi/releases) and launch it. Nothing else to
install. Windows and Linux desktop builds are coming in a future release.

The desktop app updates its own runtime from npm: when a new version ships, Settings →
General offers to install it, and it takes effect on the next restart.

### npm

```bash
npx @nagellabs/libi
```

It opens **http://localhost:3456** in your browser once the server is up. If nothing
appears — over SSH, in a container, on a machine with no desktop — the URL is printed in
the terminal; open it yourself.

Today this is tested on macOS — that's where we build and use libi daily. Broader platform
support is on the way.

The first launch sets up `~/.libi/` and downloads the binaries and models libi needs — this
takes a few minutes and prints its progress. Every launch after that is fast. If setup
fails, it says why and exits rather than starting a half-working app.

Useful flags and environment variables:

| | |
|---|---|
| `npx @nagellabs/libi --port 4000` | Serve on a different port (default `3456`) |
| `npx @nagellabs/libi --connect-agent [dir]` | **Bring your own CLI.** Serves headless and syncs agent config (instructions, MCP servers, skills) into that directory, so a Claude Code or Codex session started there gets libi's tools. Defaults to the directory you ran it from. |
| `npx @nagellabs/libi --no-open` | Don't launch a browser — just print the URL (also `LIBI_OPEN=0`) |
| `LIBI_HOME=/path/to/dir` | Move the data directory somewhere other than `~/.libi` |
| `LIBI_DEBUG=1` | Verbose MCP transport logging |

---

## Run from source

If you'd rather run the checkout directly (developed and tested on macOS):

```bash
git clone https://github.com/Nagellabs/libi.git
cd libi
npm install
npm run dev            # http://localhost:3456
npm run dev:electron   # …and the desktop shell
```

**Always start libi through `npm run dev` (i.e. `node bin/libi.js`), never `next dev`.** The
CLI runs an install-and-probe phase before Next.js boots; skipping it leaves the bundled MCP
servers uninstalled and the agent with no tools.

```bash
npm test               # unit + integration (Vitest)
npm run test:e2e       # end-to-end (Playwright)
npm run test:electron  # desktop end-to-end
npm run lint
npm run db:generate    # regenerate the Drizzle migration after a schema change
```

Logs land in `~/.libi/logs/` — `server.log` for Next.js output, `libi.log` for structured
application events (`tail -f ~/.libi/logs/libi.log | jq`).

Conventions, architecture notes and the rules the codebase is held to live in
[`AGENTS.md`](./AGENTS.md).

---

## How it fits together

```
Claude Code / Codex  (subprocess)
     │  ACP over stdio
     ▼
Next.js server  ──  AgentProcessManager · SessionManager · JobManager
     │  stdio
     ▼
MCP server  ──  libi.* tools (pieces, scenes, overlays, audio, files, ffmpeg, tracking…)
     ▼
~/.libi/  ──  SQLite · media storage · logs · bundled binaries
```

A **piece** holds a composition: canvas scenes (agent-written draw functions) plus a track
of timed, layered overlays and audio clips. The same renderer drives the preview and the
canvas export path, so what you see is what you get. Agent actions write the composition,
the server pushes an event, and the editor re-renders — there is no hidden local state.

Built on Next.js 16, React 19, Electron, SQLite + Drizzle, Tailwind v4, ffmpeg, WebCodecs
(mediabunny), and the Agent Client Protocol + Model Context Protocol SDKs.

---

## Privacy

Everything you make stays on your machine. libi sends two kinds of telemetry, both
switchable off in **Settings → Privacy**, and both disabled automatically when you run from
a cloned repo:

- **Crash and error reports** (Sentry) — stack traces and surrounding logs so we can fix
  what broke. No user identity, no IP addresses, no request bodies; credential-shaped keys
  and values are scrubbed before anything leaves the machine. Turn it off and no report is
  sent at all — the toggle takes effect immediately, no restart. `LIBI_SENTRY_DISABLED=1`
  is a hard kill-switch that overrides everything.
- **Product analytics** (GA4) — bounded, enumerated events like "a piece was created", keyed
  to a random per-install id. Never file names, prompts, or anything you typed.

Full details: [privacy policy](https://libi.nagellabs.com/privacy).

---

## Contributing

**Pull requests are not being accepted right now — libi is still in beta.** The architecture
is moving fast and large parts of it are still settling, so I can't give outside PRs the
review they deserve, and I'd rather not leave anyone sitting on a branch that goes stale
underneath them. PRs opened against this repository will be closed without review. I'll
announce here and in [CONTRIBUTING.md](./CONTRIBUTING.md) when that changes.

**Issues, on the other hand, are very welcome and genuinely appreciated.** Bug reports,
crashes, reproductions, feature requests and any rough edge you hit while actually using
libi are the most useful thing you can send us right now. We read them, and we'll do our
best to address them.

- [**Open an issue**](https://github.com/Nagellabs/libi/issues) — the fastest route, and public so others benefit
- A reproduction (steps, and a log excerpt from `~/.libi/logs/libi.log`) makes a report dramatically more actionable
- Can't reach the tracker? Email **support@nagellabs.com** — no GitHub account needed
- Anything security-sensitive: **admin@nagellabs.com**, not a public issue — see
  [SECURITY.md](./SECURITY.md) for the disclosure process and threat model

---

## License

libi is free and open source under **[GPL-3.0-only](./LICENSE)**. See
[SECURITY.md](./SECURITY.md) for the security policy and how to report a vulnerability.

Use it for anything, personal or commercial. Modify it, fork it, run it however you like. If
you *distribute* a modified version, ship its source under GPL as well. **The videos you
make with libi are yours** — the license covers libi's code, not your output.

The editor is free forever; an optional paid membership adds cloud services on top (team
sharing, backup, managed model usage) and never gates anything already in the box. See
[LICENSING.md](./LICENSING.md) for the plain-English version, and
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md) for the notices of every production
dependency the packaged app redistributes.

Copyright © 2026 Nadav Nagel.
