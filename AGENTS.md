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
tail -f ~/.libi/logs/server.log                            # Next: compile errors, requests, [browser] errors
tail -f ~/.libi/logs/libi.log | jq 'select(.tag == "…")'   # app-level structured logs
```

Tags in use: `ffmpeg` (pair with `.op`), `proxy`, `filmstrip`, `export`, `overlay`,
`analysis`, `tracking-engine`, `tracking-pyenv`, `matte`, `mcp-config`, `session-manager`,
`lifecycle`, `snapshot`, `codex-config`, `terminal`, `analytics`, `onboarding`.

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
- **Agent availability is never decided by `which claude` / `which codex`.** libi installs
  its own CLIs and puts nothing on PATH; a PATH probe reports working installs as broken.
  "Installed" ≠ "signed in" ≠ "the user has their own CLI" — see
  `lib/agents/agent-readiness.ts`. `needs-auth` is only ever set from an *observed* auth
  rejection, never inferred by probing credentials. The one place the user's own binary
  genuinely is the question is the `codex mcp add` flow
  (`lib/codex-config/codex-cli.ts#userCodexCli`), which asks the login shell and rejects
  any hit inside libi's own tree.
- Never hand-edit `~/.codex/config.toml`. Codex re-serializes it and ate users' TOML;
  registration goes through codex's own `codex mcp add` (`lib/codex-config/`).

**Licensing — legal, not stylistic**
- `@agentclientprotocol/claude-agent-acp` **MUST stay a `devDependency`.** It transitively
  pulls a proprietary ~212 MB Anthropic binary that libi (GPL-3.0) has no licence to
  redistribute. Three gates enforce it: `scripts/check-licenses.sh`,
  `electron-builder.yml`'s `files` exclusions, and the `afterPack` hook. `codex-acp` is
  Apache-2.0 and stays bundled. Same reasoning blocks hosting the AGPL-derived YOLOE
  export — it is built on the user's machine from pinned inputs instead.

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
runtime-installed Claude adapter) are different things.

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
  never spinners or "Loading…" text.
- **UI:** add `cursor-pointer` to every interactive element — base-ui's `Button` doesn't set
  it. Tailwind v4, dark theme.
- **Naming:** the user-facing entity is a **Piece** (`pieces`, `pieceId`, `Piece`).

## When you add…

- **A new MCP tool** — implementation in `mcp/tools/`, Zod v3 schema in
  `mcp/tools/schemas.ts`, register in `mcp/server.ts`. Paid tools hosted on bundled MCPs
  gate on `generation: true` in `mcp/registry/bundled.ts`; paid tools on libi's own MCP have
  no automatic gate, so the owning skill must make the agent disclose cost and confirm.
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
by *fetching* Electron prebuilds, never compiling on a user's machine. The release cadences
are documented in an internal runbook, not part of this repository — see
`scripts/release-npm.js` and `scripts/release-electron.js` for the actual mechanics.

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
