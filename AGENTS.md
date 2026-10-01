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

Both e2e suites start their own studio from this checkout (scratch home, test mode, their own
Next dir, so they run beside a dev app): web on `LIBI_E2E_PORT` (3465), Electron on
`LIBI_ELECTRON_E2E_PORT` (3477) with a `/tmp/` home; each needs its port and the next one free.
To attach the Electron specs to a studio already running instead, export BOTH its port and its
home: `LIBI_PORT=<p> LIBI_HOME=/tmp/<its home> npm run test:electron` (a home outside `/tmp/`
skips `libi-home-and-export.spec`); attached, the harness starts no studio of its own. `launchLibi()` refuses to open a shell when nothing answers
on the port, rather than leave the shell's "did not respond" dialog on screen. Their Next dirs
(`LIBI_NEXT_DIST_DIR` = `.next-e2e`, `.next-electron-e2e`) are pre-listed in tsconfig.json; any
other value makes `next dev` edit that tracked file — run a second dev app from another worktree.

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

Tags in use: `ffmpeg` (pair with `.op`), `proxy`, `filmstrip`, `export` (`record_*` ops: every `piece_exports` write), `overlay`,
`analysis`, `tracking-engine`, `tracking-pyenv`, `matte`, `mcp-config`, `mcp-http`,
`session-manager`, `lifecycle`, `snapshot`, `codex-config`, `terminal`, `analytics`,
`onboarding`, `skills`, `video-download`, `providers`, `db`, `agent-cli`, `agent-install`,
`libi-registration`, `process-manager`, `agent-registry`, `session-event-handler`, `social`,
`templates`, `templates-cloud` (the publish and install jobs, the use reporter, the pending-publish route, publish requests and their confirm),
`social-music` (rights and music at posting: `plan_resolved`, `catalog_unavailable`, `account_kind_detected`,
`export_audio_excluded`, `template_music_pending`, `template_music_fetched`; also `rights_set`, `owned_refused`,
`facts_put_refused`, `facts_get_refused`, `catalog_refused`, `track_refused`, `preview_refused`, `preview_failed`,
`piece_rights_read_failed`, `pending_music_read_failed`, `template_example_audio_dropped`, `template_music_rights_failed`),
`overlay-sandbox`, `uv-env` (op `uv_offline`: a uv run that could not download its managed Python or packages;
`python_prefetched` / `python_prefetch_failed` / `python_prefetch_schedule_failed`: the background Python prefetch),
`e2e` (the test-only `/api/e2e/*` routes: `run_tool_refused`, `run_tool_failed`),
`dep-install` (binary placement, the cross-process `install_lock_*` ops, `partial_swept` / `partial_sweep_failed`),
`deps` (DependencyManager's install path: `download_start` / `download_retry` / `installed`, `install_start`,
`wrapper_written`, `custom_installer_start` / `custom_installer_ok` / `custom_installer_failed`, `retry_failed`,
`dep_install_joined` / `dep_install_served_elsewhere`: the single-flight/cross-process join ops, …),
`tts` (op `synth_failed`: a Kokoro run that exited non-zero, timed out or could not spawn),
`storyboard` (per-piece file lock ops in `lib/storyboard/lock.ts`, sketch re-render in `watcher.ts`, and
`render_file_refused`: `slotUnitPath`'s fallback when a card's `render.file` fails the safe-path check).

## Hard rules

Every one of these has broken something. Do not relax one without evidence.

**Booting**
- **Never `next dev`.** `bin/libi.js` runs Category A (node, ffmpeg/ffprobe — everything
  else is on demand) and resolves LIBI_HOME and the ports *before* Next starts. Skip it and
  the agent's tools fail.
- **Inside a git worktree, boot dev from that worktree.** Booting from the canonical
  checkout serves *that* code — you will "verify" a fix that isn't running. The dev entry
  points auto-detect the worktree (own `LIBI_HOME`, port, and an **empty DB** — recreate
  fixtures there). Confirm the sidebar brand badge shows the worktree name.
  Each worktree needs its own `npm ci` (then `ensure-native-modules` + `ensure-electron-binary`);
  the canonical `node_modules` is not a fallback — `bin/libi.js` refuses a worktree without its own.

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
- A Next `font/google` build error in a worktree is a stale `.next`: `rm -rf .next` and
  boot again. So is `Cannot find module '<package>-<hash>'` on the first boot after
  `turbopack.root` changed (next.config.ts), and the same goes for `.next-e2e` and
  `.next-electron-e2e`.

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
  rejects any hit inside libi's own tree; realpaths every hit (deduping by realpath); runs
  `--version` on each in search order under a hard 3 s bound per copy and takes the FIRST that
  meets `AGENT_CLI_MIN_VERSION` (`lib/agents/cli/min-versions.ts`) — none does → the first
  copy's answer, as before. It stops at the first qualifying copy (usually one spawn) and checks
  at most `AGENT_CLI_MAX_VERSION_CANDIDATES` (4), so a cold resolve is about 6.5 s when the first
  copy answers and bounded at about 15.5 s if every copy hangs. First-hit-only is what let an old
  `/opt/homebrew/bin/claude` shadow a current fnm one when the login-shell probe missed fnm. The
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
- libi never stores a provider API key, and never writes an agent's config. One exception: a provider the user
  connects for libi's own UI may grant libi an OAuth token, obtained through a browser sign-in the user completes,
  held in the OS keychain (or a private 0600 file under npx), never in the database, never in an API response, and
  revocable both in libi and at the provider. Today that is Zernio, for the Social page and a piece's Posting tab
  (`lib/social/`); the agent's own Zernio sign-in is a separate entry libi never reads.
  **Nothing reads the keychain unless a grant is being written or read.** On macOS even
  `safeStorage.isEncryptionAvailable()` is a keychain read, and a read the item's access list doesn't cover is
  a login-password prompt; 0.1.16 asked it at every launch. The shell's cipher is lazy
  (`electron/secret-cipher.ts`), `status()` of an absent grant never touches it, and only a write asks
  `available()` (`cipherForWrite`). A release-created item trusts libi's signing identity, so updates never
  prompt; an item a local QA pack created first is pinned to that build's cdhash and prompts the installed app
  until "Always Allow" (owner's machine, 2026-09-29).
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
  The permission route takes `browserOnlyRefusal`: a card is answered from libi's page,
  never by a header-less loopback client.
- **An agent can prepare a publish; only the user can publish.** `libi.publish_template`
  runs the local preflight, then its `template_publish_prepare` job makes the request's OWN
  example and poster (`lib/templates/cloud/publish-request-media.ts`) and records a publish
  request (`lib/templates/cloud/publish-requests.ts`) — nothing is uploaded (the prepare
  path reads the creator's status from the catalog, nothing more). The
  review plays exactly those files and the publish job sends exactly them, re-deriving
  nothing: never "resolve the example at publish time" again. The user publishes from the
  Templates page's review panel — armed after 1.5 s, with the rights box ticked for that request,
  and inside the desktop window a native Electron confirm on top (`electron/confirm-publish.ts`).
  That dialog guards clicks in the desktop window ONLY: any real browser on the studio's loopback
  port (Chrome driven by an agent's browser tool, a Playwright MCP) loads the same panel with no
  bridge and publishes through the browser-only confirm without it, and a compromised renderer
  can skip it. Closing that needs main-to-server attestation, which does not exist yet (the gap is
  in `lib/approval/extensions.ts` LIMITATIONS); never treat the dialog as the gate. The panel's
  confirm route is the ONLY thing that starts `template_publish` (in-process,
  `lib/templates/cloud/publish-confirm.ts`); `POST /api/jobs` refuses the kind from every
  caller and `/api/jobs/:id/retry` never re-runs it (`lib/jobs/user-started-kinds.ts`). Never
  give a publish back to an approval card, a `confirm` flag or a tool call: a card never shows
  under bypass, a settings allow-rule, Codex or `libi connect`. The confirm is bound to the
  reviewed content's fingerprint (template + the request's media bytes), single-use, and needs
  the browser-only checks (`browserOnlyRefusal`) plus a `confirmCode` no tool, tool result or
  log line ever carries. The same checks guard visibility, the nickname and the creator key's
  import and reveal; the approval card's answer, the approval mode and an extension's "Require
  approval" switch (`libi.update_mcp_server` may only turn it ON); social publish / schedule /
  edit / delete / retry (an agent's `libi.post_piece` draft is exempt), connect / disconnect and
  the social settings; the catalog report; and a chat's Restart session
  (`POST /api/sessions/:id/restart`). Honest limits in `lib/approval/extensions.ts`
  LIMITATIONS.
- **Song matching speaks the provider abstraction only.** `lib/social/music-match.ts`, the
  `music-match` / `platform-picks` routes, `libi.audio_add_clip` / `libi.set_audio_rights` and the
  music UI read catalogs through `SocialAdapter` (`withAdapter`) and decide everything platform-shaped
  (search vs trending, draft handoff, the picker's note) from `PLATFORM_MUSIC_RULES` — never a
  provider import or a provider field name (`__tests__/unit/social/music-provider-neutral.test.ts`).
  A song's per-platform pick lives on the file (`AudioRights.platformPicks`), written only through
  `lib/audio-rights/platform-picks.ts#setPlatformPick`: the automatic match and the agent never
  replace or clear the user's pick, and the user's pick route is browser-only.
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
  — hence the `libi-app` alias in `lib/agents/mcp-tool-id.ts` is LIVE, not just history.
  When the retry fails too, the conflict is between the user's OWN config files (seen 2026-09-29:
  a project `.codex/config.toml` libi ≤ 0.1.13 left in its agent folder, stdio, under the user's
  url entry), and no rename helps: readiness becomes `config-error` with codex's own words (the
  real text is in the rejection's `data` — its `message` is just "Internal error"), New chat
  retries a fresh session, and the first clean one brings the standby back. libi still edits no
  config file — the message tells the user which section to remove. The second consequence:
  `enabled = false` survives, costing every libi tool with nothing thrown, so it is
  named in the log instead (`session-manager/libi_mcp_entry_disabled`, cause read from
  `codex mcp list --json`, never from parsing the user's TOML). An
  in-app-only tool asked for on a `cli` session logs and errors (`mcp/http/session.ts`) —
  a tripwire for the replacement having failed, not a routine path; gate a new
  tool to in-app and you must list it in `IN_APP_ONLY_TOOLS` (a drift test enforces it). The aggregator serves libi's OWN tools and nothing else: it proxies no
  third-party MCP, and the in-app session gets exactly one `mcpServers` entry — except in
  test mode, where the fake fal-ai / ElevenLabs stdio servers ride along under their real
  names (`lib/mcp-config.ts#getMcpServersForAcp`).
- **The proxy checks the loopback Host on every `/api` request, reads included** (DNS
  rebinding; `lib/security/request-guard.ts#evaluateRequestOrigin`). It does NOT refuse
  cross-site GETs in general. The opaque-origin sandbox, test-mode catalog media at
  `127.0.0.1` under a `localhost` page, and the PDF viewer all read cross-site legitimately.
  A GET with an outside effect (it spends the creator key, calls the site, or writes)
  refuses cross-site requests itself, navigations included, with `crossSiteSubresourceRefusal`.
  Today that is `/api/templates/cloud/mine`, `/api/templates/cloud/catalog`,
  `/api/templates/cloud/catalog/[cloudId]` (a public template's page reads the site and its template.json),
  `/api/templates/cloud/asset-stream` (it fetches a public template's link-only audio/video from a third-party host,
  SSRF-checked on every hop — lib/templates/cloud/asset-stream.ts),
  `/api/social/music/preview` (it fetches a social catalog track's preview from the platform's own CDN,
  allow-listed hosts only, through the same guarded fetch — lib/social/music-preview.ts),
  `/api/social/music/catalog` and `/api/social/music/track` (they call Zernio on the user's grant),
  `/api/social/music/facts` (its GET probes each account through Zernio and stores the facts),
  `/api/files/by-id/[fileId]/music-match` (it matches a song against each connected platform's
  catalog through the adapter, on the user's grant),
  `/api/templates/cloud/creator` (it spends the creator key on the site's approval read), and the
  GETs of `/api/templates/cloud/author` and `/api/templates/cloud/key` (they create the creator
  identity, with its default nickname, on first view). Three GETs still answer a cross-site request
  and only skip their effect: `/api/providers` (restarting an idle Codex adapter),
  `/api/pieces/[pieceId]` (re-making the open piece's evicted proxies), and
  `/api/templates/cloud/publish-requests/[id]/media/[name]` (the `publish_request_media_not_found`
  warn line — it 404s a bad request/name pair either way). `/api/providers` answers every caller
  but restarts an idle Codex adapter for a new launcher only when it is not refused.
- **A chat's third-party MCP servers are read when its session is created — including the
  standby libi pre-creates for the next New chat.** A provider added after the standby was made
  (Providers tab, or the user's own `claude mcp add`) is missing from the chat it becomes, while
  the tab says a new chat has it (found on Windows: fal.ai Connected, no fal tools). So
  `openNewSession` discards a standby whose agent MCP config changed since, or that overlapped a
  setup terminal (`lib/sessions/standby-freshness.ts`, `lib/terminal/setup-activity.ts`), and that
  chat starts fresh. Don't drop the check to win back the standby's ~2 s.
- **Restarting a chat is CLOSE, then load — for both adapters** (`SessionManager.restartSession`, the
  session menu's Restart session; user-only route). A `session/load` of a session the adapter still
  holds re-reads nothing: claude-agent-acp returns early on an unchanged fingerprint and keeps its
  `claude` child; codex-acp re-attaches to the live thread. Measured 2026-09-25: a server added to the
  config after the session was created started on close + load, never on load alone. Neither needs the
  adapter PROCESS restarted (one process serves every chat of an agent); it is replaced only when the
  close or the load goes unanswered within its bound, and never while another chat on it is working
  or being opened; idle chats on it drop their ACP session and reload on their next message.
- Nothing writes CLAUDE.md, AGENTS.md, `.mcp.json` or `settings.local.json` into any folder.
  Instructions are tiered: a short core in the MCP `instructions` field plus
  `libi.read_manual` for the rest — SECTIONED (`mcp/manual-sections.ts`), because the
  manual is ~87 KB and a client spools a result that size to disk: no argument returns
  the index plus the pre-first-edit essentials, a key returns one section, `"all"` the
  lot; skills are the only files on disk (`.claude/skills`,
  `.agents/skills`), mirrored by `libi connect` and into `~/.libi/agent`.

**Overlay sandbox**
- **Custom effect bodies (`animate.js`: `libi.add_effect` / `update_effect` / git
  installs) never run in the app origin either** — not in the preview, not on `/render`.
  The effect sampler (`lib/sandbox/effect-sampler.ts`), a sandbox of its own on the same
  runtime bundle, runs the body and answers with a numeric table (1025 samples of every
  `TransformDelta` field, `lib/effects/curve.ts`); the page validates every number and
  interpolates (`lib/effects/custom-curves.ts`). The preview draws identity until a curve
  lands and repaints; the export samples every custom slot before its first frame and a
  failure fails it naming the effect. The server only PARSES a body
  (`compile-custom.ts`), never calls it; an import-boundary test keeps both body runners
  out of every page bundle.
- **Storyboard sketch bodies run server-side, in a Node child that locks itself before a
  body runs** (`lib/storyboard/render/lock-runtime.ts`): Node's permission model does not
  gate the network, so after one trusted warm-up render the worker refuses every further
  module resolution and leaves only a data-only `process` — otherwise a body could speak
  to libi's loopback routes itself. A render library that loads something lazily must be
  warmed before the lock, never by loosening it; a Node without `module.registerHooks`
  renders nothing.
- **Code, three and tracked-code bodies never compile in the app origin, or on any main
  thread.** They run in a CLASSIC `blob:` Worker (`lib/sandbox/runtime-entry.ts`: a module
  worker does not load at an opaque origin, and the worker's base URL is its blob, so the
  bundle inlines every dependency), spawned by a sandboxed supervisor iframe that never
  runs a body (`lib/sandbox/supervisor.ts`; `connect-src 'none'` in
  `lib/security/csp.ts#buildOverlayRuntimeCsp`). `renderFrame` calls no body. The regex
  denylist in `lib/ai/scene-validator.ts` is defense in depth, not the boundary: a
  `composition.json` can arrive by routes no tool call saw. No "trusted" flag that skips
  the sandbox, no user-facing toggle. `LIBI_OVERLAY_SANDBOX=0` is dev-only and
  preview-only (refused when packaged or under `NODE_ENV=production`; export always
  sandboxes — `lib/sandbox/mode.ts`).
- Nothing in `lib/sandbox/runtime/` may touch `document`, `window` or `Image`; a worker has
  none. Hence `drawSvg`/`svgToImage` do not work in the sandbox (Blink rasterizes SVG only
  on a document) — tell bodies to use `new Path2D(svgPathData)`. `runtime/harden.ts` stubs
  or deletes every escape and task source it lists (`fetch`, `Worker`, `MessageChannel`,
  `scheduler`, …) on every owner in the prototype chain, and after boot locks the worker's
  own `postMessage` so a body cannot flood the supervisor thread. A task source neither
  stubbed there nor owner-tagged (`runtime/async-owner.ts`) is one a wedge can hide behind.
- A body sees exactly the documented context
  (`lib/sandbox/runtime/compile.ts#buildDrawBodyContext`) plus the helper bag — no
  `sourceCanvas`, `overlays`, `tracks`, `assets`. `loadImage` accepts `data:` URLs and
  this piece's own image files (`/api/files/by-id/<id>/content`); anything else, `blob:`
  included, is refused.
- **Known limits, stated plainly.** All bodies of a piece share ONE worker realm (spec A3):
  a body can patch shared intrinsics, and alter or read its sibling overlays in the same
  piece, or get them dropped. Only the runtime's own channel is protected (its primitives
  are captured before any body runs). That is why the Templates flag
  `PUBLIC_CODE_TEMPLATES` (`lib/templates/cloud/constants.ts`) must
  stay `false` until bodies run in one worker per provenance. Async work the runtime
  cannot tag (a browser promise, an event listener) falls back to a heuristic suspect
  when it wedges the worker. Custom effect bodies likewise share one sampler worker realm.
  Three open sandbox re-review findings also block `PUBLIC_CODE_TEMPLATES`: an async-switch flood is blamed on the thread holder before
  its sender, so an unpatched storm can get a sibling dropped (R-M1), and the
  worker truncates error text with the live `String.prototype.slice`, so a body
  can make every error it posts IPC-sized (R-M2), and `errorMessage` (`serve.ts`) tells
  an oversized layer by a live-realm `instanceof OversizedLayerError` and reads its
  `layerSize`, both forgeable by a body (R2-M3). A three body's shader that never
  ends hangs the GPU process, which no worker restart can fix. Every availability bound
  (port message budget, layer size, frame liveness) is enforced by the host
  (`lib/sandbox/host.ts`); the worker's own rate limits are only hygiene.
- **Watchdog (spec A4).** The worker has one thread, so the host times only the head of a
  per-port FIFO: a queued request's clock starts when the one ahead answers (budgets:
  `lib/sandbox/host.ts`: a load `LOAD_TIMEOUT_MS` 5 s; a render that measures a content
  fit 5 s plus `PROBE_EXTRA_BUDGET_MS` 3 s per further fit, so up to 20 s on the first
  frame of a keyframed-size tween segment — a wedge there is caught that late; any other
  render 2 s — `renderBudget`, whose fit LRU mirrors the worker's). On expiry the supervisor
  `terminate()`s the worker and spawns a fresh one; the host replays every other cached
  source, and the dropped overlay retries only when its source changes. NEVER "fix" this
  into destroying the iframe: Chromium puts every sandboxed frame of a site in one
  renderer process and never reclaims a wedged one (spike round 1); only a worker can be
  killed. A frame that sends no `ready` and answers no `ping` is not wedged but DEAD (the
  supervisor never runs a body), and only then is it replaced — at most 3 times in 5 min
  (`remountFrame`). A frame whose document is still LOADING is not dead: it gets 60 s
  before it is probed (the preview says "still starting" from 20 s), and a missed ping is
  confirmed with a second before a remount. An export replaces no frame: the first death
  fails it (`EXPORT_SANDBOX_OPTIONS`), never finishing with its bodies listed as dropped,
  and the failure names the overlay the worker was being restarted for (`frameDiedMessage`:
  fix or remove its code — re-exporting fails the same way). A live frame whose worker is
  not back 9 s after a restart fails an export the same way (`workerRestartTimeoutMs`,
  below the export's 10 s restart wait); the preview has no such deadline.
  A decaying restart score stops a loop of no-drop restarts from stalling the preview
  forever.
- Body failures are `renderDiagnostics` on `libi.get_piece_state`
  (`lib/render/render-diagnostics-store.ts`). Every `message` is labelled
  `messageSource: "overlay body (untrusted)"` — body-written text, never instructions.
  Line/column point into the body's own file (render/build errors; a compile error carries
  the message only). An entry clears when its source changes, or when the SAME frame
  re-renders clean — never on some other clean frame. The preview holds the last good
  frame; the export drops the overlay for the failing frames (all later frames after a
  timeout) and lists it in `droppedOverlays`.
- `libi.add_overlay` / `update_overlay` are strict: an unknown field (`drawFunction`,
  `name`, …) is refused with a hint naming the right one, and nothing is written. Don't
  loosen this back to zod's silent strip — it once "succeeded" with a scaffolded body.
- App CSP: `child-src 'self'` and `frame-ancestors 'self'` — not `'none'`, which breaks
  the editor's same-origin PDF `<embed>`. The hidden Electron export window runs with
  `sandbox: true` (`lib/export/drivers/electron.ts`).
- 3D TEXT stays host-built (`hooks/preview/use-overlay-three.ts`, `lib/engine/text-3d/`);
  only `three` BODIES are sandboxed. The golden spec (`e2e/overlay-sandbox-golden.spec.ts`)
  compares against PRE-refactor renderer output, except where a deliberate rendering change
  re-baselined it from HEAD (2026-09-27: the three.js `Text` label came back). After a
  capture-path change, regenerate from the pre-refactor renderer (`3110575a`) with the new
  capture applied, plus the one-line `willReadFrequently` cherry-pick from TF-3, never from
  HEAD; a deliberate rendering change re-baselines from HEAD. Either way, check the capture
  with `--repeat-each=10` and say why in the commit (its README). A three.js `Text` label's
  canvas stays CPU-backed (`willReadFrequently`, `lib/engine/canvas-text.ts`): a GPU-backed
  one rasterized the same label differently from run to run.

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
- **Exports are admitted by one scheduler** (`lib/export/scheduler.ts`; pure rules in
  `lib/export/admission.ts`, costs in `lib/export/cost.ts`, tuned by measurement —
  `docs-local/superpowers/spikes/2026-09-29-export-concurrency.md`). Never add another
  serializer (a `maxConcurrent: 1`, a lane, a lock) around an export or `export_render`: it hides
  exports from the scheduler's queue. Every render acquires a reservation after it knows its
  backend and releases it in a `finally`. A template example render is `background` and yields to
  any foreground export. An encoder session refused at runtime lowers `hwSessionCap` for the
  process (`schedule_hw_cap_lowered`); only session-specific words count (`isHwEncoderSessionError`),
  never ffmpeg's generic "Error while opening encoder". An export admitted a moment ago still counts
  its estimated memory for `MEMORY_RAMP_MS`, and so does each admission within one pass.
- **`libi.export_video` with `variants` (1–10) queues, it never waits** (`exportVideoVariants`,
  `mcp/tools/export-tools.ts`): one `POST /api/export` per entry (`batchSize` = the count, for the
  `export_queued` analytics bucket), answering `{ queued: [{ exportId, name, format, width, height }], note }`
  at once; a refusal stops the batch and returns what was already queued. The scheduler runs them. It is
  the tool's own argument — nothing to do with the social code's `ExportVariant` (with-song / without-song,
  `lib/social/music-policy.ts`), which a variant merely expresses through `copyrightedAudio`.

**Media**
- Server-side ffmpeg **export** backends read the ORIGINAL file via
  `storage.localPath(...)`, never `file.proxyFilename`. Proxies are ≤1080p scrub-friendly
  stand-ins, not outputs.
- Alpha-bearing video never gets a proxy — an H.264 yuv420p proxy silently restores the
  background a user just removed. `files.has_alpha` gates this in three places.
- Every `runFfmpeg` call passes a fixed `op` string from the existing set; extend the set
  rather than inventing free-text values.
- **ffmpeg-path colour:** `drawbox` on a YUV frame always paints BT.601, so draw coloured
  boxes on an RGBA layer and `overlay` it; untagged HD inputs are declared BT.709
  (`lib/export/untagged-color.ts`) because browsers and QuickTime read them that way,
  and an untagged SD base exported at a non-SD size is converted 601→709 by its scale —
  players read the OUTPUT by the output's size, not the source's.
  Overlay `enable` windows are half-open like the preview — build them with `windowExpr`,
  never `between(t,…)` (touching cues overprinted for a frame). CI's ffmpeg is < 7.1, so
  the colour assertions skip there: a green CI proves nothing about export colour.
- **Copyrighted audio is decided in ONE place per concern, and `owned` is the user's alone.** Every
  reader goes through `lib/audio-rights/read.ts#effectiveRights`. Uploads are the user's own:
  both UI upload routes and `libi.upload_file` stamp `owned` by provenance (`uploadedStamp`); only
  downloads (yt-dlp) and remote imports (`remote_fetch`) are stamped copyrighted. An unstamped file
  reads by provenance — `aiGeneration` / `[Music] ` → generated, a `Downloaded from ` breadcrumb →
  copyrighted, anything else → owned (owner decision 2026-09-28; it was "null = copyrighted").
  Exports through `lib/export/audio-policy.ts` applied to the MANIFEST in
  `renderExport` (a video's sound is an inline clip — never add a second exclusion inside a
  backend; stream-copy is forced off when anything is excluded); posting music through
  `lib/social/music-policy.ts#resolveMusicPlan` (composer, Posting tab and `libi.post_piece` alike).
  An agent never decides `owned`: besides upload provenance (and a template's carried bytes, which
  apply stamps owned), only `PATCH /api/files/by-id/:id/audio-rights` behind `browserOnlyRefusal`
  writes it, and `libi.set_audio_rights` refuses it (a track edit keeps who decided an owned file).
  A template never carries a copyrighted file: extract turns it
  into a `musicLinks` entry (or a video slot), apply leaves it in `Composition.pendingMusic`, and
  only `libi.fetch_template_music`, after the user's yes, downloads it. The agent's `generated`
  stamp is trusted like any generation tool's provenance — an advisory limit, not a check.

**Data lifecycle**
- Adding piece-scoped data (table, files, external state)? Make sure piece DELETE cleans it
  up (`app/api/pieces/[pieceId]/route.ts`). FK `onDelete: "cascade"` covers DB rows;
  nothing else is automatic.
- Never hand-edit generated migrations under `drizzle/`.
- Outside `<LIBI_HOME>/agent`, skill roots are written only through
  `writeSkillsToRoot({ external: true })`; libi may delete only manifest-listed real skill
  folders there — never a link, a file, or a folder it didn't write.
- **Exports live in the piece.** A finished export is `<storage>/<pieceId>/exports/<name>.<ext>`
  plus a `piece_exports` row (lib/exports/store.ts) — the row is the source of truth; an
  `export` job row can be replaced by a same-params re-export, the record can't. There is no
  export-folder setting: never write an export anywhere else, and never accept a `destFolder`
  (refused with `DEST_FOLDER_REFUSAL`, `lib/exports/types.ts`). Rename and delete are user-only
  routes (`browserOnlyRefusal`) that wait for a social upload of the file. "Copy" puts the FILE on
  the clipboard through Electron main's `libi:copy-file` (electron/copy-file.ts), which copies only a
  regular file directly inside a piece's `exports/`; everywhere else the page copies the path.

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

Core model: a **piece** holds a `Composition` = `overlays: Overlay[]` (`text | image | video |
code | three`, timed, rect-positioned, z-ordered — `code` is where an AI-written JS draw
function lives) + `audioClips`. **There is no video scene** — every video is a
`VideoOverlay`, and the old canvas-scene layer (`scenes: CanvasScene[]`) is gone; `loadManifest`
(`lib/composition/persistence.ts`) drops it from any pre-2026-08-20 manifest still carrying it
(logged `overlay/legacy_scenes_dropped` once per piece PER PROCESS — the studio and its MCP
child each log their own). The editor tells the user once per piece, remembered server-side in
`settings.legacyScenesNoticed`: never in browser storage, whose origin changes with the packaged
app's port on every launch.
`renderFrame()` (`lib/engine/renderer.ts`) is the one compositor shared by preview and canvas
export.

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
artifacts while publishing nothing, so a shell can be debugged for free. One caveat: the
bundle's CONTENTS come from npm by version, so a dry run against the PREVIOUS version
measures that version's dependency tree (on 0.1.14 it failed the size ceiling
spuriously) — the shells can't be meaningfully rehearsed before their own npm publish. The release
cadences themselves are in an internal runbook; `scripts/release-npm.js` and
`scripts/release-electron.js` hold the actual mechanics.

## Electron + CDP (driving the desktop app)

`npm run dev:electron` exposes Chrome DevTools Protocol on :9222 in dev (`LIBI_CDP=0` to
opt out; never in packaged builds). `.mcp.json` registers `@playwright/mcp` against it.

- Launch with the `Libi Electron` entry in `.claude/launch.json` (`preview_start`), then
  drive it with the **`browser_*` (Playwright MCP) tools** — `browser_take_screenshot`,
  `browser_snapshot`, `browser_click`, `browser_type`, `browser_evaluate`,
  `browser_console_messages`. `preview_stop` when done.
- `scripts/dev-electron.js` recompiles `dist-electron/` (esbuild, ~30 ms) on every launch, in the
  checkout it actually runs — a dev shell is never a stale preload. Package.json hooks don't
  matter: `.claude/launch.json` runs the script directly.
- **Do NOT use the `preview_*` tools to interact with Electron.** They attach to a regular
  Chrome tab, so you'd "verify" something the desktop window never rendered.
- **Crash gotcha:** Electron's built-in detached DevTools plus an external CDP client =
  two front-ends on one target → Chromium CHECK-fails with `SIGTRAP` ~20s in
  (`CrBrowserMain` in the macOS `.ips`; looks like a random rendering crash). Launch with
  `LIBI_NO_DEVTOOLS=1` when remote-driving. `LIBI_DISABLE_GPU=1` does **not** fix this one.
- `npm run test:electron` owns its own lifecycle and is safe to run alongside a dev shell.
