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
        pinnedInstallToken: "2026-07-24",
        requireBundled: true,
        // Actually exec `ffmpeg -version` after install — an existing binary
        // that can't run (wrong CPU arch) is treated as not-installed and
        // re-fetched, instead of passing verification on file-existence alone.
        runCheck: ["-version"],
        downloadUrl: {
          darwin: {
            arm64:
              "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffmpeg.zip",
            x64: "https://evermeet.cx/ffmpeg/getrelease/ffmpeg/zip",
          },
          linux:
            "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
          win32:
            "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
        },
        archive: {
          format: "zip", // macOS; Linux/Windows actually deliver zip + tar.xz — DependencyManager auto-detects via `tar -xf`
          binaryPathInArchive: {
            // Both macOS zips (evermeet x64, martin-riedl arm64) extract a
            // single `ffmpeg` file at root.
            darwin: "ffmpeg",
            // johnvansickle tar extracts ffmpeg-*-amd64-static/ffmpeg
            linux: "ffmpeg-*-amd64-static/ffmpeg",
            // gyan.dev zip extracts ffmpeg-*-essentials_build/bin/ffmpeg.exe
            win32: "ffmpeg-*-essentials_build/bin/ffmpeg.exe",
          },
        },
      },
      {
        binary: "ffprobe",
        // Same rationale as ffmpeg above — don't let a homebrew/system
        // ffprobe shadow the static build we control. darwin arch-keyed
        // 2026-07-24 for the same evermeet-is-x86_64-only reason (see ffmpeg).
        pinnedInstallToken: "2026-07-24",
        requireBundled: true,
        runCheck: ["-version"],
        downloadUrl: {
          darwin: {
            arm64:
              "https://ffmpeg.martin-riedl.de/redirect/latest/macos/arm64/release/ffprobe.zip",
            x64: "https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip",
          },
          linux:
            "https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz",
          win32:
            "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip",
        },
        archive: {
          format: "zip",
          binaryPathInArchive: {
            darwin: "ffprobe",
            linux: "ffmpeg-*-amd64-static/ffprobe",
            win32: "ffmpeg-*-essentials_build/bin/ffprobe.exe",
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
            win32: "uv-x86_64-pc-windows-msvc/uv.exe",
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
    command: "uvx",
    args: ["elevenlabs-mcp"],
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
            win32: "uv-x86_64-pc-windows-msvc/uv.exe",
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
            win32: "uv-x86_64-pc-windows-msvc/uv.exe",
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
            win32: "uv-x86_64-pc-windows-msvc/uv.exe",
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
            win32: "uv-x86_64-pc-windows-msvc/uv.exe",
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
