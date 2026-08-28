import * as path from "node:path";
import type { BundledMcpDef } from "./types";

/**
 * Libi's own MCP server + bundled external MCPs.
 *
 * The `libi` entry is special (`core: true`): it represents the libi server
 * itself, which is synthesized at runtime by `lib/mcp-config.ts#buildLibiEntry`
 * rather than spawned from a command. Its presence in this list exists so the
 * Settings UI can show it with its binary dependencies (ffmpeg, ffprobe)
 * and so the DependencyManager knows to download them.
 */
export const STATIC_BUNDLED_MCP_SERVERS: BundledMcpDef[] = [
  {
    id: "libi",
    name: "Libi",
    description:
      "Libi's built-in video editing tools. Cannot be disabled. Bundles ffmpeg and ffprobe for media probing/trimming/audio extraction/thumbnail generation/concatenation, plus Playwright Chromium for canvas-scene exports and the MediaPipe-based object tracker.",
    npmUrl: null,
    type: "stdio",
    command: "",
    args: [],
    requireApproval: false,
    core: true,
    dependencies: [
      {
        binary: "chromium",
        // Implementation lives in `installers.ts` (server-only) — keeping the
        // server-only imports (`fs`, `playwright-core`) out of the client
        // bundle that imports bundled.ts via the Settings UI.
        customInstallerId: "playwright-chromium",
      },
      {
        // MediaPipe Tasks Vision wasm + model assets used by the
        // headless-Chromium face/object tracker (`lib/tracking/track-entry.ts`).
        // Bundled locally so the tracker never depends on jsdelivr / GCS at
        // runtime. Files land under `~/.libi/models/mediapipe-vision/` and are
        // served via `/api/models/[...path]`.
        //
        // `pinnedInstallToken` is the @mediapipe/tasks-vision npm tag the
        // URLs point to. Bump this when changing any file URL so users
        // re-fetch — without it, file-existence checks would keep the old
        // assets forever.
        binary: "mediapipe-vision",
        pinnedInstallToken: "2026-05-15",
        destination: "models",
        files: [
          {
            url: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.wasm",
            relPath: "wasm/vision_wasm_internal.wasm",
            sha256: "6a5c64584c2ab61c763b6e204afbdbc7ce1caf7f5216187322bca8df94f646bc",
          },
          {
            url: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_internal.js",
            relPath: "wasm/vision_wasm_internal.js",
            sha256: "e7fd9858e8e8f221d9b96eddc11f8e077f263e0b7bbd79d3cbe882b134274f8c",
          },
          {
            url: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_nosimd_internal.wasm",
            relPath: "wasm/vision_wasm_nosimd_internal.wasm",
            sha256: "8a3092d34c79d3f57e6ba8592105e8a90f6b07c27891ffecd14cca428bfd3e31",
          },
          {
            url: "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm/vision_wasm_nosimd_internal.js",
            relPath: "wasm/vision_wasm_nosimd_internal.js",
            sha256: "438d1fe8ff7f4d946025bc211c291543c037d8a3785ed4eee60f1f521b236296",
          },
          {
            url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
            relPath: "models/face_landmarker.task",
            sha256: "64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff",
          },
          {
            url: "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite",
            relPath: "models/blaze_face_short_range.tflite",
            sha256: "b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f",
          },
          {
            url: "https://storage.googleapis.com/mediapipe-models/object_detector/efficientdet_lite0/float16/1/efficientdet_lite0.tflite",
            relPath: "models/efficientdet_lite0.tflite",
            sha256: "4b59100025bea1235a84c1038879a6cccc9f6c49f5e41144e91e74d99e780993",
          },
        ],
      },
      {
        binary: "ffmpeg",
        // URLs are "latest" aliases — pinnedInstallToken acts as a force-
        // re-install lever. Bump to today's date to push all users to
        // re-fetch the current upstream build.
        //
        // 2026-05-23: bumped + requireBundled added. The default
        // `brew install ffmpeg` on macOS skips `--enable-libfreetype`, so
        // text overlays (drawtext filter) silently fail with "No such
        // filter: 'drawtext'". evermeet/johnvansickle/gyan/martin-riedl
        // static builds all include freetype + libopus + libvpx-vp9 +
        // libx265 — exactly the filter+codec surface the export pipeline
        // relies on.
        //
        // 2026-07-24: darwin arch-keyed. evermeet.cx ships x86_64-ONLY
        // builds, so on Apple Silicon (no Rosetta) the binary can't exec at
        // all — probeMedia() then silently swallows the failure and every
        // media op (audio detection, proxies, thumbnails, exports) breaks
        // without a signal. arm64 now pulls martin-riedl.de's aarch64 static
        // build (its /redirect/latest/.../release/ alias mirrors evermeet's
        // "getrelease" latest-alias and includes drawtext). Token bumped so
        // existing wrong-arch installs re-fetch.
        //
        // 2026-08-16: LINUX MOVED OFF johnvansickle. The 2026-05-23 note above
        // claimed all four sources "include freetype". That was wrong for
        // johnvansickle, and it cost every Linux user their text overlays:
        //   [AVFilterGraph] No such filter: 'drawtext'
        // Measured on the shipped artifact — 486 filters, no drawtext, and a
        // direct render smoke test fails. Its `-version` configuration string
        // DOES advertise --enable-libfreetype/--enable-fontconfig/--enable-libass,
        // which is why reading that string (or trusting `-version` to exit 0)
        // never caught it.
        // BtbN/FFmpeg-Builds linux64-gpl was measured on the same box before
        // switching: 563 filters, drawtext present, and it renders. Same GPL
        // footing as johnvansickle (both carry libx264, which the export
        // pipeline uses as its encoder) and downloaded on the user's machine
        // at runtime, never redistributed.
        // See `capabilityCheck` below — the guard that would have caught this.
        pinnedInstallToken: "2026-08-23",
        requireBundled: true,
        // Actually exec `ffmpeg -version` after install — an existing binary
        // that can't run (wrong CPU arch) is treated as not-installed and
        // re-fetched, instead of passing verification on file-existence alone.
        runCheck: ["-version"],
        // `-version` only proves the binary EXECUTES. It cannot tell you the
        // binary can do what libi needs, and the two are not the same thing:
        // the johnvansickle build ran perfectly and had no drawtext filter.
        // Assert the capability itself.
        capabilityCheck: {
          args: ["-filters"],
          // drawtext is what every text overlay on the ffmpeg export path
          // compiles to. Without it `ffmpeg-overlay` fails outright and the
          // user just sees a failed export.
          mustContain: ["drawtext"],
        },
        downloadUrl: {
          darwin: {
            arm64:
              "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip",
            x64: "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip",
          },
          // BtbN, not johnvansickle — see the 2026-08-16 note above.
          linux:
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
          // BtbN, not gyan.dev — 2026-08-23. Same move linux made on 2026-08-16,
          // and for a sharper reason: gyan.dev is one person's server with no
          // mirror, and it served HTTP 503 for three straight attempts during
          // the first Windows QA run. ffmpeg is not tier-1, so Category A
          // reported "complete" and libi came up as a video studio with no
          // ffmpeg at all. GitHub release assets are not immune to outages,
          // but they are not a single host, and this is now the SAME archive
          // linux pulls — one upstream to reason about instead of two.
          //
          // "essentials" was also the wrong build to depend on: the name
          // advertises a REDUCED feature set, which is exactly the shape of
          // the Linux drawtext defect (F5). The gpl build is the full one.
          win32:
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
        },
        archive: {
          format: "zip", // macOS; Linux/Windows actually deliver zip + tar.xz — DependencyManager auto-detects via `tar -xf`
          binaryPathInArchive: {
            // Both macOS zips (evermeet x64, martin-riedl arm64) extract a
            // single `ffmpeg` file at root.
            darwin: "ffmpeg",
            // BtbN tar extracts ffmpeg-*-linux64-gpl/bin/ffmpeg — note the
            // `bin/` level, which johnvansickle's layout did not have.
            linux: "ffmpeg-*-linux64-gpl/bin/ffmpeg",
            // BtbN zip extracts ffmpeg-*-win64-gpl/bin/ffmpeg.exe — the same
            // shape as the linux tar above, which is the point of moving.
            win32: "ffmpeg-*-win64-gpl/bin/ffmpeg.exe",
          },
        },
      },
      {
        binary: "ffprobe",
        // Same rationale as ffmpeg above — don't let a homebrew/system
        // ffprobe shadow the static build we control. darwin arch-keyed
        // 2026-07-24 for the same evermeet-is-x86_64-only reason (see ffmpeg).
        //
        // 2026-08-16: linux moved to BtbN alongside ffmpeg. These two MUST come
        // from the same upstream archive — they are a matched pair, and mixing
        // a BtbN ffmpeg with a johnvansickle ffprobe would mean probing with a
        // different build than the one doing the encoding.
        pinnedInstallToken: "2026-08-23",
        requireBundled: true,
        runCheck: ["-version"],
        // No capabilityCheck: ffprobe has no filter graph. Its counterpart
        // guarantee is that it comes from the same archive as ffmpeg above.
        downloadUrl: {
          darwin: {
            arm64:
              "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip",
            x64: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip",
          },
          linux:
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-linux64-gpl.tar.xz",
          // BtbN, not gyan.dev — 2026-08-23. Same move linux made on 2026-08-16,
          // and for a sharper reason: gyan.dev is one person's server with no
          // mirror, and it served HTTP 503 for three straight attempts during
          // the first Windows QA run. ffmpeg is not tier-1, so Category A
          // reported "complete" and libi came up as a video studio with no
          // ffmpeg at all. GitHub release assets are not immune to outages,
          // but they are not a single host, and this is now the SAME archive
          // linux pulls — one upstream to reason about instead of two.
          //
          // "essentials" was also the wrong build to depend on: the name
          // advertises a REDUCED feature set, which is exactly the shape of
          // the Linux drawtext defect (F5). The gpl build is the full one.
          win32:
            "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
        },
        archive: {
          format: "zip",
          binaryPathInArchive: {
            darwin: "ffprobe",
            linux: "ffmpeg-*-linux64-gpl/bin/ffprobe",
            win32: "ffmpeg-*-win64-gpl/bin/ffprobe.exe",
          },
        },
      },
    ],
  },
  {
    id: "youtube-downloader",
    name: "YouTube Downloader",
    description: "Download YouTube videos via yt-dlp",
    npmUrl: "https://www.npmjs.com/package/@kevinwatt/yt-dlp-mcp",
    type: "stdio",
    // Installed into ~/.libi/node_modules/@kevinwatt/yt-dlp-mcp/ at the
    // pinned version (see `lib/mcp/bundled-install.ts`) and spawned from
    // ~/.libi/node_modules/.bin/yt-dlp-mcp. The DB row keeps `npx` here as
    // a fallback for environments where the install hasn't happened yet
    // (fresh boot, install failure) — `local-bin-resolver` chooses local
    // when the bin shim exists.
    command: "npx",
    // 0.9.0 rewrote tool registration onto McpServer.registerTool + SDK 1.29,
    // which emits real JSON Schemas. 0.8.4 passed raw zod-v4 objects as
    // inputSchema, so array params (e.g. get_video_metadata's `fields`)
    // reached the agent as serialized zod internals and got sent stringified
    // → "Invalid input: expected array, received string" rejections.
    args: ["-y", "@kevinwatt/yt-dlp-mcp@0.9.0"],
    npmPackage: "@kevinwatt/yt-dlp-mcp",
    pinnedVersion: "0.9.0",
    binName: "yt-dlp-mcp",
    requireApproval: false,
    installFlow: "tier-2",
    installPlanPath: "mcp/bundled-mcps/plans/yt-dlp.md",
    dependencies: [
      // uv must install first — yt-dlp's custom installer shells out to it.
      // Listed redundantly with elevenlabs's uv dep; install-token dedup makes
      // this idempotent (already-installed uv is skipped).
      {
        binary: "uv",
        installFlow: "tier-1",
        pinnedInstallToken: "2026-05-15",
        downloadUrl: {
          darwin: {
            arm64: "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz",
            x64: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz",
          },
          linux: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz",
          win32: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
        },
        archive: {
          format: "tar.gz",
          binaryPathInArchive: {
            darwin: {
              arm64: "uv-aarch64-apple-darwin/uv",
              x64: "uv-x86_64-apple-darwin/uv",
            },
            linux: "uv-x86_64-unknown-linux-gnu/uv",
            // NOT "uv-x86_64-pc-windows-msvc/uv.exe", by symmetry with the
            // lines above. astral-sh publishes the unix builds as tarballs
            // that unpack into a directory named after the target, and the
            // Windows build as a zip with the executables at the ROOT:
            //   uv.exe, uvw.exe, uvx.exe
            // Assuming the symmetry cost libi every Windows boot — uv is a
            // tier-1 dep, so the lookup failure aborted Category A and the
            // app could not start at all (observed on Windows 11, 2026-08-22).
            win32: "uv.exe",
          },
        },
      },
      {
        binary: "yt-dlp",
        installFlow: "tier-1",
        // Custom installer: `uv tool install yt-dlp` → symlink into ~/.libi/bin.
        // The PyInstaller-onefile binary upstream publishes is 35 MB and has
        // an ~11s cold start that was racing the MCP SDK's spawn timeout
        // under parallel-spawn. uv-managed install is a real Python script
        // (~150ms cold start). uv tracks the installed yt-dlp version in its
        // own metadata; no pinnedInstallToken needed here.
        customInstallerId: "yt-dlp-uv",
      },
    ],
    agentInstructions:
      "CANONICALIZE YouTube URLs before calling ANY YouTube Downloader tool: keep only the single-video " +
      "`https://www.youtube.com/watch?v=<id>` form (or `https://youtu.be/<id>`) and STRIP every extra query " +
      "parameter — `list`, `start_radio`, `index`, `pp`, `t`, etc. A URL carrying `&list=RD…`/`&start_radio=1` " +
      "is a Radio/Mix (an effectively endless auto-playlist); the downloader does not force `--no-playlist`, so " +
      "yt-dlp tries to enumerate the whole mix and HANGS until the 120s tool timeout fires (both metadata and " +
      "download fail). Passing the bare `watch?v=<id>` URL avoids this entirely. " +
      "After downloading a file with the YouTube Downloader, you MUST import it into the piece's storage " +
      "using `libi.upload_file` with the downloaded file's path. Do NOT leave files in the downloads folder " +
      "or any other location outside the piece. Once imported, tell the user the file has been added to their " +
      "resources and ask what they'd like to do with it (e.g., create a video scene, use as an audio track, " +
      "extract audio, etc.).",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    description:
      "Speech-to-text, text-to-speech, sound effects, music generation, voice cloning, and audio isolation via the official ElevenLabs MCP server. Required for the default video-analysis transcript step.",
    npmUrl: null,
    pypiUrl: "https://pypi.org/project/elevenlabs-mcp/",
    type: "stdio",
    // `uv tool run`, NOT `uvx`. They do the same thing, but `uvx` is a second
    // binary in the uv archive and the dependency below extracts only `uv` —
    // so `spawn("uvx", …)` could never resolve out of ~/.libi/bin, and this
    // MCP could not start on ANY platform unless the user happened to have
    // Homebrew's uv on PATH. Verified on a fresh 0.1.2 home: bin/ held
    // ffmpeg, ffprobe, node and uv, and nothing else.
    command: "uv",
    args: ["tool", "run", "elevenlabs-mcp"],
    requireApproval: true,
    installFlow: "tier-2",
    installPlanPath: "mcp/bundled-mcps/plans/elevenlabs.md",
    generation: true,
    requiredEnvVars: ["ELEVENLABS_API_KEY"],
    dependencies: [
      {
        binary: "uv",
        // URL is a "latest" alias — pinnedInstallToken acts as a force-
        // re-install lever. Bump to today's date to push all users to
        // re-fetch upstream.
        pinnedInstallToken: "2026-05-15",
        downloadUrl: {
          darwin: {
            arm64: "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz",
            x64: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz",
          },
          linux: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz",
          win32: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
        },
        archive: {
          format: "tar.gz",
          binaryPathInArchive: {
            darwin: {
              arm64: "uv-aarch64-apple-darwin/uv",
              x64: "uv-x86_64-apple-darwin/uv",
            },
            linux: "uv-x86_64-unknown-linux-gnu/uv",
            // zip root, not a target directory — see the uv dep above.
            win32: "uv.exe",
          },
        },
      },
    ],
    agentInstructions:
      "For the transcript step in video analysis, call `libi.elevenlabs_transcribe_audio_override` " +
      "(NOT the bundled `speech_to_text` — that one returns plain text and drops word-level timing). " +
      "The override tool returns the full ElevenLabs response with the `words` array; pass that array into " +
      "`libi.analysis_save_transcript`'s `metadata.words` (schema_version: `transcript_v1`). " +
      "It also exposes `text_to_speech`, `text_to_sound_effects`, `compose_music`, `voice_clone`, " +
      "and `isolate_audio` — use those when the user explicitly asks. Always check tool availability " +
      "with `libi.list_bundled_mcps` before assuming the server is configured.",
  },
  {
    id: "fal-ai",
    name: "fal-ai",
    description:
      "Image, video, audio, and 3D generation via fal.ai's 1,000+ models. Generation runs cost real credits — uses your fal API key.",
    npmUrl: null,
    type: "http",
    command: "",
    args: [],
    url: "https://mcp.fal.ai/mcp",
    headers: { Authorization: "Bearer ${FAL_KEY}" },
    requireApproval: true,
    installFlow: "tier-2",
    installPlanPath: "mcp/bundled-mcps/plans/fal-ai.md",
    generation: true,
    dependencies: [],
    requiredEnvVars: ["FAL_KEY"],
    agentInstructions:
      "fal.ai exposes generation models (image / video / audio / 3D). When the user asks to generate any of these, follow the `ai-asset-generation` skill — do not call fal tools directly without it.",
  },
  {
    id: "libi-tracking",
    name: "Libi Tracking",
    description:
      "Local multi-object tracking engine (boxmot + ONNX). Lazily installed (tier-2).",
    npmUrl: null,
    type: "stdio",
    // In-repo MCP spawned by the libi CLI (same package as core). The
    // npx form is the packaged-build fallback only; `inRepoEntry` makes
    // `resolveBundledSpawn()` resolve the tsx-direct entry from the source
    // tree in EVERY spawn path (prober, diagnose, session) — mirroring how
    // the core libi server's tsx entry is used everywhere.
    command: "npx",
    args: ["libi", "serve-mcp-tracking"],
    inRepoEntry: path.join("mcp", "tracking-mcp", "index.ts"),
    requireApproval: false,
    core: false,
    installFlow: "tier-2",
    installPlanPath: "mcp/bundled-mcps/plans/libi-tracking.md",
    dependencies: [
      {
        // Local tracking engine: a uv-managed Python sidecar (boxmot
        // BoT-SORT/ReID + onnxruntime + opencv + torch) plus the four
        // ONNX model artifacts (TransNetV2 shot detect, YOLOE detect,
        // VitTrack SOT). Implementation lives in
        // installers/tracking-pyenv.ts (server-only). tier-2 so that
        // the ~1 GB engine install does NOT block boot — it is lazily
        // provisioned when the libi-tracking MCP is first used.
        // pinnedInstallToken bump forces a re-sync / re-provision
        // (date convention — the sidecar pin set lives in
        // mcp/tracking/py/pyproject.toml, models in models.json).
        binary: "tracking-pyenv",
        installFlow: "tier-2",
        pinnedInstallToken: "2026-05-16",
        customInstallerId: "tracking-pyenv",
      },
    ],
  },
  {
    id: "whisper",
    name: "Whisper (local STT)",
    description:
      "Local, free speech-to-text via faster-whisper. Default transcript provider — no API key, runs on-device. Transcription executes inside libi's analysis pipeline; ElevenLabs remains available for diarization or on explicit request.",
    npmUrl: null,
    pypiUrl: "https://pypi.org/project/faster-whisper/",
    type: "stdio",
    command: "",
    args: [],
    noServer: true,
    requireApproval: false,
    installFlow: "tier-2",
    installPlanPath: "mcp/bundled-mcps/plans/whisper.md",
    requiredEnvVars: [],
    dependencies: [
      // uv runs faster-whisper via `uv run --with`. tier-1 so it is
      // pre-warmed at boot (shared with yt-dlp/elevenlabs; install-token
      // dedup makes the duplicate idempotent).
      {
        binary: "uv",
        installFlow: "tier-1",
        pinnedInstallToken: "2026-05-15",
        downloadUrl: {
          darwin: {
            arm64: "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz",
            x64: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz",
          },
          linux: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz",
          win32: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
        },
        archive: {
          format: "tar.gz",
          binaryPathInArchive: {
            darwin: {
              arm64: "uv-aarch64-apple-darwin/uv",
              x64: "uv-x86_64-apple-darwin/uv",
            },
            linux: "uv-x86_64-unknown-linux-gnu/uv",
            // zip root, not a target directory — see the uv dep above.
            win32: "uv.exe",
          },
        },
      },
      // Whisper model status + download is owned by the
      // `whisper-model` virtual dep (see lib/mcp-virtual-deps/whisper.ts).
    ],
    agentInstructions:
      "Default transcript provider. Call libi.analysis_transcribe_audio({ fileId }) — provider defaults to whisper. " +
      'If it returns status:"needs_install", run libi.get_install_plan({ mcpId: "whisper" }) and follow it, then retry. ' +
      "If transcript accuracy is poor, call libi.whisper_list_models and suggest a larger model to the user; only " +
      "download medium/large after the user confirms via libi.whisper_download_model.",
  },
  {
    id: "local-tts",
    name: "Local TTS (Kokoro)",
    description:
      "Local, free text-to-speech via Kokoro-82M. Default speech provider — no API key, runs on-device. Synthesis runs inside libi via libi.generate_speech. ElevenLabs remains available for voice cloning or on explicit request.",
    npmUrl: null,
    pypiUrl: "https://pypi.org/project/kokoro-onnx/",
    type: "stdio",
    command: "",
    args: [],
    noServer: true,
    requireApproval: false,
    installFlow: "tier-2",
    installPlanPath: "mcp/bundled-mcps/plans/local-tts.md",
    requiredEnvVars: [],
    dependencies: [
      // uv runs kokoro-onnx via `uv run --with`. tier-1 so it is
      // pre-warmed at boot (shared with yt-dlp/elevenlabs/whisper; install-token
      // dedup makes the duplicate idempotent).
      {
        binary: "uv",
        installFlow: "tier-1",
        pinnedInstallToken: "2026-05-15",
        downloadUrl: {
          darwin: {
            arm64: "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz",
            x64: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz",
          },
          linux: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz",
          win32: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
        },
        archive: {
          format: "tar.gz",
          binaryPathInArchive: {
            darwin: {
              arm64: "uv-aarch64-apple-darwin/uv",
              x64: "uv-x86_64-apple-darwin/uv",
            },
            linux: "uv-x86_64-unknown-linux-gnu/uv",
            // zip root, not a target directory — see the uv dep above.
            win32: "uv.exe",
          },
        },
      },
      // Kokoro model status + download is owned by the `tts-model`
      // virtual dep (see lib/mcp-virtual-deps/local-tts.ts). The
      // download runs through downloadModel() in lib/tts/synthesize.ts.
    ],
    agentInstructions:
      "Default speech provider. Call libi.generate_speech({ text }) — voice defaults to af_heart. " +
      'If it returns status:"needs_install", run libi.get_install_plan({ mcpId: "local-tts" }) and follow it, then retry. ' +
      "Use libi.tts_list_voices to pick or suggest a different voice. Use ElevenLabs only when the user explicitly asks or needs a specific cloned voice.",
  },
  {
    id: "local-music",
    name: "Local Music (ACE-Step)",
    description:
      "Local, free music generation via ACE-Step (Apache-2.0). Default music provider — no API key, runs on-device. Generation runs inside libi via libi.generate_music. Paid/licensed music remains available on explicit request.",
    npmUrl: null,
    pypiUrl: "https://pypi.org/project/acestep/",
    type: "stdio",
    command: "",
    args: [],
    noServer: true,
    requireApproval: false,
    installFlow: "tier-2",
    installPlanPath: "mcp/bundled-mcps/plans/local-music.md",
    requiredEnvVars: [],
    dependencies: [
      // uv runs acestep via `uv run --with`. tier-1 so it is pre-warmed
      // at boot (shared with whisper/local-tts/yt-dlp/elevenlabs;
      // install-token dedup makes the duplicate idempotent).
      {
        binary: "uv",
        installFlow: "tier-1",
        pinnedInstallToken: "2026-05-15",
        downloadUrl: {
          darwin: {
            arm64: "https://github.com/astral-sh/uv/releases/latest/download/uv-aarch64-apple-darwin.tar.gz",
            x64: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-apple-darwin.tar.gz",
          },
          linux: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz",
          win32: "https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip",
        },
        archive: {
          format: "tar.gz",
          binaryPathInArchive: {
            darwin: {
              arm64: "uv-aarch64-apple-darwin/uv",
              x64: "uv-x86_64-apple-darwin/uv",
            },
            linux: "uv-x86_64-unknown-linux-gnu/uv",
            // zip root, not a target directory — see the uv dep above.
            win32: "uv.exe",
          },
        },
      },
      // ACE-Step weights status + download is owned by the
      // `ace-step-model` virtual dep (see lib/mcp-virtual-deps/local-music.ts).
      // The download runs through the music_model_download JobManager
      // runner backed by lib/music/models.ts.
    ],
    agentInstructions:
      "Default music provider. Call libi.generate_music({ prompt }) — duration defaults to ~30s. " +
      'If it returns status:"needs_install", tell the user the download size from the payload, get approval, run libi.get_install_plan({ mcpId: "local-music" }) and follow it, then retry. ' +
      'On status:"confirm_duration" tell the user the estimate and re-call with confirm:true. ' +
      'On status:"insufficient_memory", the host does not have enough free RAM (~14 GB needed for the 3.5B pipeline). Tell the user the free/total from the payload, suggest closing apps, then retry on their go-ahead. Do NOT spin. ' +
      'On status:"model_load_failed" call libi.music_download_model({ force: true }) then retry once. ' +
      "Before EACH generation call, tell the user the ~12 GB RAM peak — generation is memory-heavy, not just slow. " +
      "Use libi.music_list_styles for style hints. Use paid/licensed music only when the user explicitly asks." +
      "\n\nMusic analysis (added 2026-05-20):\n" +
      "- libi.music_detect_beats({ fileId }) — tempo + beat times + onsets. " +
      "Use the returned beatTimes[] in canvas scenes via the beatPulse(beats, time) " +
      "and nearestBeat(beats, time) helpers in the draw scope. " +
      "- libi.music_profile({ fileId }) — tempo + key + energy + a suggestedPrompt string. " +
      "Pass that prompt back to ANY music generator (libi.generate_music, " +
      "elevenlabs.compose_music, fal-ai music) to make 'similar' music. " +
      'On { status: "needs_install" } from either analysis tool, call ' +
      "libi.get_install_plan({ mcpId: 'local-music' }) and follow Section B " +
      "(the analyze env is independent from the ACE-Step weights and has its own gate). " +
      'On { status: "insufficient_memory" }, free RAM and retry; analyze needs ~1 GB free.',
  },
];

export const BUNDLED_MCP_SERVERS: BundledMcpDef[] = [...STATIC_BUNDLED_MCP_SERVERS];
