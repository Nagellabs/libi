// lib/video-download/install-size.ts
//
// What the first `libi.download_video` call installs, in the units the user
// sees. A LEAF on purpose — no imports — for the same reason as
// `lib/export/chromium-size.ts`: `mcp/registry/bundled.ts` (the
// `youtube-download` row's description, imported by the Settings UI) and the
// MCP child (`mcp/tools/video-download-tools.ts`, the agent's disclosure)
// both need the same number, and neither may import the runner that does the
// installing (`lib/jobs/runners/video-download.ts`).
//
// The figure is the on-disk total of what `ensureDep("youtube-download", …)`
// fetches on a fresh machine: the `uv` binary, the python-build-standalone
// interpreter `uv tool install` pulls on first use, and yt-dlp itself with
// its dependencies. Approximate by construction — uv's Python archive is the
// bulk of it and its size moves with the pinned interpreter — and stated as
// decimal MB, as everywhere else in libi.

/** "~125 MB": uv + a managed Python + yt-dlp, installed once, on first use. */
export const YT_DLP_INSTALL_MB = 125;
