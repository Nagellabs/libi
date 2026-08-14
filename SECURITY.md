# Security Policy

## Reporting a vulnerability

Email **admin@nagellabs.com**. Please don't open a public issue for anything
security-sensitive.

Include what you'd include in any good bug report: the version (`npm` package version, or
the desktop build), your OS, steps to reproduce, and what you expected vs. what happened. A
proof-of-concept piece or log excerpt from `~/.libi/logs/libi.log` helps a lot.

libi is a solo-maintained project in beta. There's no SLA — I'll acknowledge a report as
soon as I can, but "as soon as I can" might be days, not hours. I will not ask you to wait
on a disclosure timeline before going public if I've gone quiet; use your judgment.

## Trust model

libi runs entirely on your own machine, as your own OS user. It is a local application, not
a hosted service and not a sandbox — it has exactly the file access, network access, and
process-spawning ability that you do. Anything an attacker gets libi to do, they could do
themselves with a terminal. libi does not claim to isolate itself from the rest of your
system, and treating it as if it did is a mistake in *your* threat model, not a promise
libi has made and broken.

Within that, some specific hardening is in place and worth naming because it narrows the
practical attack surface even though it isn't a sandbox boundary:

- The local HTTP server binds to `127.0.0.1` only — it is not reachable from other machines
  on your network.
- Outbound fetches that follow a user- or agent-supplied URL are SSRF-guarded: DNS is
  resolved and the connection is pinned to the resolved address, so a redirect or DNS
  answer can't retarget a request at an internal service after the URL was validated.
- File reads through the storage layer re-check the resolved path via `realpath`, so a
  symlink can't be used to escape the directory a read was supposed to be confined to.
- Skill installs refuse symlinks in the installed tree.

None of this changes the fact that libi runs with your full user privileges. It reduces a
few specific classes of bugs (network pivoting, path-traversal-via-symlink) becoming
worse than they need to be — it does not add a security boundary around the app as a whole.

## Pieces are executable content

A **piece** is not inert media. It contains AI-authored JavaScript (canvas draw functions)
that runs when the piece is opened — in the app's own renderer, at the app's own origin,
with access to the local API. Opening a piece is closer to opening a script than opening a
video file.

**Do not open a piece from a source you don't trust**, the same way you wouldn't run a
random shell script from the internet. This applies whether the piece arrives as a file, a
shared project, or anything else that lands in `~/.libi/`.

`lib/ai/scene-validator.ts` denylists a set of dangerous patterns (`fetch`, `eval`,
`Function`, `require`, `process`, `__proto__`, computed property access to those names, and
similar) in AI-generated draw-function code. That file's own header is explicit about what
this is and isn't:

> DEFENSE-IN-DEPTH, NOT A SECURITY BOUNDARY. This denylist is a best-effort filter against
> obvious abuse; a determined attacker can always obfuscate around a regex denylist (string
> concatenation, char codes, etc.).

Treat it as a guardrail against accidental misuse (an agent stumbling into a dangerous
pattern), not as something that makes an untrusted piece safe to open.

## Third-party binaries: HTTPS, not checksum-pinned

libi downloads several third-party binaries and models on first use, over HTTPS:

- **ffmpeg** and **ffprobe** (static builds from `ffmpeg.martin-riedl.de`, `evermeet.cx`,
  `johnvansickle.com`, and `gyan.dev`, depending on platform)
- **uv** (from `github.com/astral-sh/uv` releases)
- The **Kokoro TTS** model and voice pack (local text-to-speech)

For these, HTTPS transport (including a redirect chain that refuses to downgrade to plain
HTTP) is currently the *only* integrity control. There is no checksum pin, so a compromise
of the upstream host or CDN, or a CA-level MITM, could substitute a malicious binary or
model that libi would then install and run unverified. This is a known, deliberate gap —
several of these are "latest" URLs that move out from under a static pin — and checksum
pinning for them is planned, not shipped. If you depend on integrity guarantees stronger
than "HTTPS was used," treat these binaries as unverified until that lands.

## What is verified

For contrast, these downloads *are* SHA-256 pinned and verified before use, and the
download is rejected if the hash doesn't match:

- The **Node.js runtime** libi provisions for itself when no usable system Node is found
  (`lib/runtime/node-runtime.ts`) — pinned per platform/arch against the official
  `nodejs.org` release.
- The **MediaPipe** WASM/vision assets and detector models used by object tracking
  (`mcp/registry/bundled.ts`) — the vision WASM/JS bundles and the face/object detector
  model files each carry a pinned SHA-256.
- The **tracking models** installed by the tracking sidecar
  (`mcp/registry/installers/tracking-pyenv.ts`) — every model artifact is downloaded (or
  rebuilt) against an expected SHA-256 and re-verified against it before it's considered
  installed.

## Known residual: `codex mcp add` and process visibility

Registering an MCP server with the Codex CLI shells out to `codex mcp add` with the
server's env vars passed inline as `--env KEY=VALUE` arguments
(`lib/codex-config/codex-cli.ts`). For the brief moment that command runs, `KEY=VALUE` is
visible in the process list (`ps`) to any other process running as your OS user.

This isn't an oversight: Codex's stdio `mcp add` has no env-var-*reference* flag (unlike its
HTTP path, which can point at an env var by name via `--bearer-token-env-var` instead of
inlining the value) — so there's no way to hand codex the value without putting it in argv.
Log output is scrubbed: this value is stripped from any failure message before it reaches
`~/.libi/logs/libi.log`, so it doesn't linger on disk. The exposure is limited to the
process-list window at registration time, to other processes running as you.

## Scope

**In scope for a report:**

- The local HTTP API and its request handling
- The Electron desktop shell
- The update path (how the desktop app or npm package fetches and applies updates)
- The MCP tool surface (`libi.*` tools, and how MCP servers are registered/configured)

**Out of scope:**

- An attacker who already has arbitrary code execution as your OS user. At that point they
  already have everything libi has — that's the trust model above, not a bug in libi.
- Third-party MCP servers you connect yourself (fal.ai, ElevenLabs, or anything else) —
  report those to their own maintainers.
