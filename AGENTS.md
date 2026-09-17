<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# libi — agent guide

**libi is an AI video studio.** A Next.js app (the actual product) that connects CLI coding
agents (Claude Code, Codex) over **ACP**, hands them `libi.*` video tools over **MCP**, and
ships either as `npx @nagellabs/libi` or inside a thin Electron shell. Agents build *pieces*;
the editor previews them frame-accurately and exports them.

This file is deliberately short: it holds the **rules and gotchas that have already cost real
time**, not an architecture tour. Read the code for structure — grep before you assume. If a
rule here disagrees with the code, the code wins; fix this file in the same change.

## Commands

```bash
npm run dev            # start libi (Category A install phase, then Next). NEVER `next dev`
npm run dev:electron   # …plus the Electron desktop shell
npm test               # Vitest — never a bare `npx vitest run` (see Testing)
npm run lint
npm run db:generate    # after ANY lib/db/schema change; commit the migration in the same change
npm run test:e2e       # Playwright (web)  ·  npm run test:electron (desktop)
```

Logs — **check both** when verifying a change:

```bash
tail -f ~/.libi/logs/server.log                            # Next: compile errors, requests, [browser] errors (dev only)
tail -f ~/.libi/logs/libi.log | jq 'select(.tag == "…")'   # app-level structured logs
```

`[browser]` relay is a Next **dev-server** feature — in production nothing forwards
renderer console output to `server.log`. The packaged app writes renderer
`console.error` lines to `~/.libi/logs/electron-main-sync.log` (electron/main.ts →
sync-log.ts); under `npx` in a real browser they exist only in that browser's DevTools
(plus Sentry for uncaught exceptions, unless opted out).

Tags in use: `ffmpeg` (pair with `.op`), `proxy`, `filmstrip`, `export`, `overlay`,
`analysis`, `tracking-engine`, `tracking-pyenv`, `matte`, `mcp-config`, `mcp-http`,
`session-manager`, `lifecycle`, `snapshot`, `codex-config`, `terminal`, `analytics`,
`onboarding`, `skills`, `video-download`, `providers`, `db`, `agent-cli`, `agent-install`,
`libi-registration`, `process-manager`, `agent-registry`, `session-event-handler`.

## Hard rules

Every one of these has broken something. Do not relax one without evidence.

**Booting**
- **Never `next dev`.** `bin/libi.js` runs Category A (bundled MCPs, ffmpeg/ffprobe,
  Chromium, models) *before* Next starts. Skip it and the agent has no tools.
- **Inside a git worktree, boot dev from that worktree.** Booting from the canonical
  checkout serves *that* code — you will "verify" a fix that isn't running. The dev entry
  points auto-detect the worktree (own `LIBI_HOME`, port, and an **empty DB** — recreate
  fixtures there). Confirm the sidebar brand badge shows the worktree name.

**Testing**
- **Always `npm test`, never `npx vitest run`.** `pretest` runs
  `scripts/ensure-native-modules.js`. Any `electron-builder` / `npm install` leaves
  `better-sqlite3` built for Electron's ABI; `new Database()` then SIGKILLs the vitest
  worker and **~250 test files vanish — counted in neither the passed nor the failed
  column**. If the summary numbers don't add up to the total, suspect this before
  believing anything else the run implies. Repair: `node scripts/ensure-native-modules.js`.
- **A green suite on your Mac is not a green CI.** CI runs ubuntu-only, so any test
  that reads `process.platform` — directly, or through code that does — can pass here
  and fail there. Pin the platform inside the test rather than inheriting the host's.
  To reproduce a Linux run for ONE file, point `--config` at a config whose
  `setupFiles` redefines `process.platform`; do NOT try it on the whole suite, where
  it breaks esbuild's binary resolution and fails 200+ unrelated files. This class of
  test is what kept CI red for five releases.

**MCP**
- MCP tool schemas import `z` from `"zod/v3"`, never `"zod"`. Under v4 the SDK's
  JSON-schema conversion fails **silently** and every tool disappears from `tools/list`.
- Nothing under `mcp/` may import `lib/jobs/*`. The MCP child doesn't run jobs — go
  through the HTTP client `mcp/jobs-client.ts`.
- **One resolver decides whether the user has a CLI: `lib/agents/cli/resolve.ts#resolveAgentCli`.**
  It searches the login-shell PATH (fresh, not on Windows; a probe still running at 2 s is
  killed by process group — SIGTERM, then SIGKILL 500 ms later — and the probe gives up
  within 3.5 s), then this process's PATH, then the known install folders (`knownInstallDirs`:
  `~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, and for Codex on macOS the
  `Contents/Resources` of `ChatGPT.app` / `Codex.app` in `/Applications` and `~/Applications`;
  on Windows `%USERPROFILE%\.local\bin`, and for Codex `%LOCALAPPDATA%\Programs\OpenAI\Codex\bin`);
  rejects any hit inside libi's own tree; realpaths the hit; runs `--version` under a hard 3 s
  bound — so a cold resolve including `--version` is bounded at about 6.5 s; and compares
  against `AGENT_CLI_MIN_VERSION` (`lib/agents/cli/min-versions.ts`). The
  status route, the process manager (which sets `CLAUDE_CODE_EXECUTABLE` / `CODEX_PATH` from
  it), provider detection, libi-registration detection and `libi connect` all read it. At
  session start (`staleOk`) a remembered result is served without waiting on a re-probe, and
  refreshed in the background — a stale memo is served only while its binary still exists and
  its result was usable; otherwise it is resolved fresh. That is deliberate: don't "fix" it
  into always re-probing, or into serving a vanished path or an unusable result. A bare
  `which claude` in the SERVER process is still wrong: a
  Finder-launched app has launchd's PATH, and an fnm/nvm shim path changes per shell — which
  is why the resolver probes the login shell and realpaths.
  "Installed" ≠ "signed in": `needs-auth` is only ever set from an *observed* auth rejection,
  never inferred by probing credentials (`lib/agents/agent-readiness.ts`). Claude authenticates at
  `session/prompt`, so a clean Claude `session/new` is never proof of sign-in, and a Claude turn whose
  reply OPENS with `Failed to authenticate` is an observed rejection (`lib/agents/session-event-handler.ts`).
- The studio server, its MCP children and its API routes never write an agent's config (no `mcp add` / `mcp remove`, installers, or sign-in). Every such write is a command printed into a setup terminal that the user submits. The one exception is the `libi connect` CLI, which the user runs by hand in their own project. The builder is `lib/agents/setup/commands.ts`; the terminals are `purpose: "setup"` PTYs owned by the Agents page.
- Never hand-edit `~/.codex/config.toml`. Codex re-serializes it and ate users' TOML; the
  only writers are codex's own `mcp add` / `mcp remove` — typed by the user in a setup
  terminal, or run by the `libi connect` CLI the user invokes.
- Approval mode `auto` maps to the agent's default (permission-routing) mode, not bypass —
  bypass suppresses the extension approval gate (`lib/sessions/approval-mode-map.ts`).
  The gate is implemented for Claude in-app sessions only, so for Codex an extension's
  `requireApproval` is advisory (the manual's REQUIRES APPROVAL prose), not enforced.
  That is a gap, **not** a platform limit — the old claim that codex-acp exposes no MCP
  tool-call approval hook was disproved live on 1.10.0: the elicitation is emitted, and
  the nameless request correlates by `toolCallId` to a `tool_call` update carrying
  `rawInput.server` / `.tool`. It could only ever fire in `ask` mode, since codex's own
  Guardian approves MCP calls in the auto modes (`lib/approval/extensions.ts` LIMITATIONS).
- **Never canonicalize a codex tool call from its TITLE.** Titles are presentation and have
  changed shape twice (`<server>/<tool>`, now `mcp.<server>.<tool>`); the `tool_call` update
  carries `rawInput: { server, tool }`, which is the contract. Use `toolIdForCall`
  (`lib/agents/mcp-tool-id.ts`) at every ingest — a null `toolId` blinds the jobs progress
  bridge, the approval gate and the chat's tool labels, and nothing fails loudly.
- libi's MCP is served over streamable HTTP by the `serve-mcp-http` child (`mcp/http/`),
  on **3457 when free** (falls back to the studio port + 1, then any free port);
  `LIBI_MCP_PORT` overrides. The live port is in `<LIBI_HOME>/mcp-port` and on the
  endpoint card (Agents → Libi MCP). The port must be STABLE across launches — `libi connect` writes the URL
  statically into `~/.claude.json`, and the packaged studio port is ephemeral.
  A supervisor-launched child gets a per-launch token that `/healthz` must echo before the
  supervisor will publish its port, and such a child shuts itself down when its stdin pipe
  closes — so it cannot outlive the libi server that spawned it; a hand-run `serve-mcp-http`
  gets no token and ignores stdin.
  The in-app agent and a user's own CLI use the SAME entry, under the SAME name
  (`LIBI_MCP_ENTRY_NAME` = `libi`, `lib/mcp/agent-surface.ts`); the only difference is the
  `x-libi-surface: in-app` header — never an env var, never a second entry. **The name
  collision is load-bearing.** libi never edits the user's config, so the only way an
  in-app session mounts libi ONCE on a `libi connect`-ed machine is for the ACP entry to
  REPLACE the config one, which both adapters do by name (Claude: `--mcp-config` beats
  config; Codex: a `thread/start` config override deep-merges per name). Codex needs
  `DISABLE_MCP_CONFIG_FILTERING=true` in the ACP child env for that
  (`lib/agents/process-manager.ts`) — codex-acp otherwise DROPS an ACP entry whose name is
  already in config, which is what the old `libi-app` name worked around at the cost of
  mounting libi twice (~194 duplicated tool schemas per in-app context). Renaming the
  in-app entry away from `libi` re-creates that twin and no migration can undo it.
  Codex merges the override into the config table FIELD BY FIELD, which has two
  consequences you must not "clean up": a hand-written STDIO `[mcp_servers.libi]` (older
  libi versions wrote those) merges to `command` + `url` and codex refuses the whole
  config, so `session/new` is caught and retried ONCE under `LIBI_MCP_FALLBACK_ENTRY_NAME`
  — hence the `libi-app` alias in `lib/agents/mcp-tool-id.ts` is LIVE, not just history;
  and `enabled = false` survives, costing every libi tool with nothing thrown, so it is
  named in the log instead (`session-manager/libi_mcp_entry_disabled`, cause read from
  `codex mcp list --json`, never from parsing the user's TOML). An
  in-app-only tool asked for on a `cli` session logs and errors (`mcp/http/session.ts`) —
  a tripwire for the replacement having failed, not a routine path; gate a new
  tool to in-app and you must list it in `IN_APP_ONLY_TOOLS` (a drift test enforces it). The aggregator serves libi's OWN tools and nothing else: it proxies no
  third-party MCP, and the in-app session gets exactly one `mcpServers` entry — except in
  test mode, where the fake fal-ai / ElevenLabs stdio servers ride along under their real
  names (`lib/mcp-config.ts#getMcpServersForAcp`).
- **A chat's third-party MCP servers are read when its session is created — including the
  standby libi pre-creates for the next New chat.** A provider added after the standby was made
  (Providers tab, or the user's own `claude mcp add`) is missing from the chat it becomes, while
  the tab says a new chat has it (found on Windows: fal.ai Connected, no fal tools). So
  `openNewSession` discards a standby whose agent MCP config changed since, or that overlapped a
  setup terminal (`lib/sessions/standby-freshness.ts`, `lib/terminal/setup-activity.ts`), and that
  chat starts fresh. Don't drop the check to win back the standby's ~2 s.
- Nothing writes CLAUDE.md, AGENTS.md, `.mcp.json` or `settings.local.json` into any folder.
  Instructions are tiered: a short core in the MCP `instructions` field plus
  `libi.read_manual` for the rest — SECTIONED (`mcp/manual-sections.ts`), because the
  manual is ~87 KB and a client spools a result that size to disk: no argument returns
  the index plus the pre-first-edit essentials, a key returns one section, `"all"` the
  lot; skills are the only files on disk (`.claude/skills`,
  `.agents/skills`), mirrored by `libi connect` and into `~/.libi/agent`.

**Licensing — legal, not stylistic**
- `@agentclientprotocol/claude-agent-acp` **MUST stay a `devDependency`.** It transitively
  pulls a proprietary ~306 MB Anthropic binary that libi (GPL-3.0) has no licence to
  redistribute. Three gates enforce it: `scripts/check-licenses.sh`,
  `electron-builder.yml`'s `files` exclusions, and the `afterPack` hook. `codex-acp` is
  Apache-2.0 — it is ALSO a devDependency installed at runtime (since 2026-09-08), but for
  size, not licence: the gates name only the Claude adapter, and must keep doing so. Same
  reasoning blocks hosting the AGPL-derived YOLOE export — it is built on the user's
  machine from pinned inputs instead.

**Long-running work**
- Anything over a few seconds runs through `JobManager` (`lib/jobs/`): persistence,
  resume, cancellation, progress/ETA, dedupe by `(kind, paramsHash)`. No ad-hoc state
  machines or retry loops. Always `reportProgress` and `checkpoint` — a silent long tool
  is the "it's been thinking forever" bug users report. Never put transient values
  (toolCallId, sessionId, timestamps) in `paramsSchema`; they break dedup.

**Media**
- Server-side ffmpeg **export** backends read the ORIGINAL file via
  `storage.localPath(...)`, never `file.proxyFilename`. Proxies are ≤1080p scrub-friendly
  stand-ins, not outputs.
- Alpha-bearing video never gets a proxy — an H.264 yuv420p proxy silently restores the
  background a user just removed. `files.has_alpha` gates this in three places.
- Every `runFfmpeg` call passes a fixed `op` string from the existing set; extend the set
  rather than inventing free-text values.

**Data lifecycle**
- Adding piece-scoped data (table, files, external state)? Make sure piece DELETE cleans it
  up (`app/api/pieces/[pieceId]/route.ts`). FK `onDelete: "cascade"` covers DB rows;
  nothing else is automatic.
- Never hand-edit generated migrations under `drizzle/`.
- Outside `<LIBI_HOME>/agent`, skill roots are written only through
  `writeSkillsToRoot({ external: true })`; libi may delete only manifest-listed real skill
  folders there — never a link, a file, or a folder it didn't write.

## Orientation

```
app/          Next App Router — (app)/editor, (app)/settings, api/*
components/   chat · editor · preview · resources · sessions · settings · terminal
hooks/        editor/ · preview/ · sessions/
lib/          the server + domain layer (engine, export, jobs, sessions, agents, db, …)
mcp/          MCP servers, libi.* tools, bundled-MCP registry, skills, tracking sidecar
electron/     desktop shell (thin — see "npm-as-runtime" below)
__tests__/    vitest unit + integration   ·   e2e/, skill-eval/, agent-eval/
docs-local/   working docs — GITIGNORED, never committed
```

Core model: a **piece** holds a `Composition` = `scenes: CanvasScene[]` (AI-written JS draw
functions; often empty) + `overlays: Overlay[]` (`text | image | video | code | three`,
timed, rect-positioned, z-ordered) + `audioClips`. **There is no video scene** — every
video is a `VideoOverlay`. `renderFrame()` (`lib/engine/renderer.ts`) is the one compositor
shared by preview and canvas export.

Data flows one way: agent calls an MCP tool → tool writes the manifest → server emits SSE
→ React Query invalidates → canvas re-renders. **No optimistic local state.**

Two seams worth knowing before you touch persistence or export:
- `loadManifest`/`saveManifest` (`lib/composition/persistence.ts`) hydrate code-bearing
  overlays from per-overlay files under storage and strip them back out on save —
  `composition.json` never contains overlay code. There is no code-string update tool; the
  agent edits the returned `codeFilePath` and a watcher revalidates.
- Export picks a backend by classifier (`lib/export/classifier.ts`): `stream-copy-trim` →
  `ffmpeg-overlay` → `canvas-source`/`chromium-render`. Code overlays and transforms force
  the canvas path.

Everything the app generates lives under `~/.libi/` (`lib/libi-home.ts`; override with
`LIBI_HOME`). Note `agent/` (the agent *workspace*) and `agents/` (an npm root for the
runtime-installed ACP adapters) are different things.

## Conventions

- **TypeScript, strict.** Match the surrounding file. Prefer editing an existing file over
  adding one. No `require()`/dynamic import to shave bundle bytes — clarity wins.
- **Logging:** no `console.*` in server / MCP / agent / session / lifecycle code. Use
  `serverLogger` or `mcpLogger` from `lib/logger.ts`, imported `as logger`, and always pass
  a `tag` plus an `op` discriminator so the stream stays filterable.
- **Data fetching:** React Query only, hooks in `lib/queries/` with query-key factories;
  mutations invalidate. One global SSE connection routes events by `sessionId` — never open
  another `EventSource`.
- **Loading states:** skeletons that mirror the real layout (`components/ui/skeleton.tsx`),
  never spinners or "Loading…" text. The exception is a wait the user started or is blocked
  on — a running download, a button whose action is still going: name it on the element the
  user is looking at, with a spinner (`components/agents-page/agents-tab/steps/busy-label.tsx`,
  `adapter-download.tsx`). A disabled button that only says "Next" reads as broken.
- **UI:** add `cursor-pointer` to every interactive element — base-ui's `Button` doesn't set
  it. Tailwind v4, dark theme.
- **Naming:** the user-facing entity is a **Piece** (`pieces`, `pieceId`, `Piece`).

## When you add…

- **A new MCP tool** — implementation in `mcp/tools/`, Zod v3 schema in
  `mcp/tools/schemas.ts`, register in `mcp/server.ts`. libi bundles no third-party MCP and
  has no `generation` gate any more; a paid tool on libi's own MCP has no automatic gate,
  so the owning skill must make the agent disclose cost and confirm.
- **A job runner** — `lib/jobs/runners/<kind>.ts`, register in `registry.ts`, set
  `mcpToolId` when an agent-called tool drives it, pick `maxConcurrent` by resource cost.
- **A bundled skill, or a substantive change to one** — ship a `skill-eval` scenario with
  it (`npm run skill:eval`, then `npm run skill:eval:index`). A unit test proves plumbing;
  only a scenario proves the inner agent still behaves. Skills stack and reference each
  other, so today's scenario is what catches tomorrow's silent break.
- **An inspector-editable overlay field** — add it to the single registry
  `lib/overlays/inspector-fields.ts` **and** the `guiding-manual-edits` skill's key list.
  A coverage test fails on drift.
- **An important user-facing feature** — emit a feature-adoption event: add the name to
  `lib/analytics/events.ts` and call `trackEvent` / `trackServerEvent` on the success path.
  Params must be bounded-cardinality enums, never user text or IDs. Agent tool use is
  already covered generically by `tool_used`; don't duplicate it.

## Verifying agent-facing work

`LIBI_TEST_MODE=1 npx @nagellabs/libi` swaps the fal-ai and ElevenLabs MCPs for local fakes
that mirror the real tool surface and return deterministic placeholder media at zero cost.
Use it after touching MCP tools, skills, agent instructions, or any `libi.*` route — the
agent walks the identical path it would in production. Calls are recorded to
`~/.libi/test-mode/*.jsonl`, which is what the skill-eval assertions read.

`curl -s http://127.0.0.1:$(cat ~/.libi/mcp-port)/healthz` answers `{ok, version, port, sessions}`;
`npx @modelcontextprotocol/inspector` against `/mcp` shows what an agent sees.

Do not claim something works because the code looks right or a unit test passed. Run it,
read both log files, and say what you actually observed. For tracking changes specifically,
the only acceptable evidence is the rendered pixels on real footage
(`npm run track:eval -- --via-product-render --assert`) — a high visible-frame count with
no flags has confidently tracked the wrong person before.

## Repo etiquette

- **Don't commit or push unless asked.** Present the change and wait. The exception is
  finishing a planned implementation step — and confirm first if the diff is large.
  Never amend a published commit.
- **Plans, specs, QA notes and investigations live in `docs-local/` — gitignored, local to
  this machine, never committed.** Do not `git add -f` them and do not create a tracked
  `docs/` directory. Source comments may cite a `docs-local/…` path as provenance; that
  path simply won't resolve in a clone.
- Pull requests are closed during beta (`CONTRIBUTING.md`). Issues are welcome.
- **The repo is public** (since 2026-08-14) and `main` is protected: force-push
  and branch deletion are blocked, for admins too. PR creation is restricted to
  collaborators; forking is open. Anything you commit is published — there is no
  longer a private-repo backstop between a mistake and the world.

## Desktop shell vs runtime

The Electron app is a **thin shell**; the product is the published npm package, shipped as
an installed snapshot inside the `.app` (and preferring a newer runtime under
`~/.libi/runtime/<version>/` when one is valid). The shell loads exactly one module out of
a runtime — `lib/runtime/shell-api.ts` — and `electron/main.ts` may not import runtime code
any other way. Bump `SHELL_API_VERSION` **only** for a breaking change; bumping it for an
added export strands every installed shell on its bundled snapshot. Native ABI is resolved
by *fetching* Electron prebuilds, never compiling on a user's machine.

That relationship is why a release is **two workflows, not one**:

- `.github/workflows/release-npm.yml` — gates, publish `@nagellabs/libi`, push the version
  commit and tag. This is what most weeks ship, and on its own it reaches every installed
  desktop app through `~/.libi/runtime/`.
- `.github/workflows/release-electron.yml` — takes an **already-published version** as an
  input, builds the macOS and Windows shells around it, and cuts one GitHub Release
  carrying both. Run it only when something under `electron/` changed.

The split is load-bearing, not organisational. While they were one workflow the shell jobs
could run only after an irreversible npm publish, so **every bug in a shell cost a version
number to discover** — two did, in one afternoon on 2026-08-28. Because the electron half
now takes the version as input, `dry_run: true` builds both shells and uploads their
artifacts while publishing nothing, so a shell can be debugged for free. The release
cadences themselves are in an internal runbook; `scripts/release-npm.js` and
`scripts/release-electron.js` hold the actual mechanics.

## Electron + CDP (driving the desktop app)

`npm run dev:electron` exposes Chrome DevTools Protocol on :9222 in dev (`LIBI_CDP=0` to
opt out; never in packaged builds). `.mcp.json` registers `@playwright/mcp` against it.

- Launch with the `Libi Electron` entry in `.claude/launch.json` (`preview_start`), then
  drive it with the **`browser_*` (Playwright MCP) tools** — `browser_take_screenshot`,
  `browser_snapshot`, `browser_click`, `browser_type`, `browser_evaluate`,
  `browser_console_messages`. `preview_stop` when done.
- **Do NOT use the `preview_*` tools to interact with Electron.** They attach to a regular
  Chrome tab, so you'd "verify" something the desktop window never rendered.
- **Crash gotcha:** Electron's built-in detached DevTools plus an external CDP client =
  two front-ends on one target → Chromium CHECK-fails with `SIGTRAP` ~20s in
  (`CrBrowserMain` in the macOS `.ips`; looks like a random rendering crash). Launch with
  `LIBI_NO_DEVTOOLS=1` when remote-driving. `LIBI_DISABLE_GPU=1` does **not** fix this one.
- `npm run test:electron` owns its own lifecycle and is safe to run alongside a dev shell.
