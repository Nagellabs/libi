import * as path from "node:path";
import type { BundledMcpDef } from "./types";
import { CHROMIUM_DOWNLOAD_MB } from "@/lib/export/chromium-size";
import { YT_DLP_INSTALL_MB } from "@/lib/video-download/install-size";

/**
 * Libi's own MCP server + its on-device extensions. libi bundles no
 * third-party MCP: providers are the user's own entries in
 * their agent's config, and libi never holds a provider key.
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
      "Libi's built-in video editing tools. Cannot be disabled. Bundles ffmpeg and ffprobe for media probing/trimming/audio extraction/thumbnail generation/concatenation.",
    kind: "core",
    toolPrefixes: [],
    npmUrl: null,
    type: "stdio",
    command: "",
    args: [],
    requireApproval: false,
    core: true,
    dependencies: [
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
          // drawtext is what every text overlay on the ffmpeg export path
          // compiles to, and since 2026-09-18 its spec places text with
          // `y_align` (ffmpeg ≥ 6.1) — a 4.4 build has drawtext and still
          // fails every text export on the unknown option. drawtext's own
          // option list answers both at once: `y_align` appears only when the
          // filter exists AND is new enough. ("drawtext" is not a usable
          // token here: "Unknown filter 'drawtext'" contains it.) Every
          // download source above is a current release, so a failing probe
          // re-fetches one that passes; it never blocks a good install.
          args: ["-h", "filter=drawtext"],
          mustContain: ["y_align"],
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
    id: "libi-export",
    name: "Canvas export (Chromium)",
    description:
      `Headless Chromium, used only when an export cannot be composited by ffmpeg — code overlays, 3D text, tracked layers, keyframed motion. Downloaded the first time such an export runs (~${CHROMIUM_DOWNLOAD_MB} MB), or from the Download button on this row.`,
    kind: "extension",
    // `libi.export_video` (mcp/server.ts) is the only `libi.export*` tool in
    // the tree. Owning it is what lets Settings show an install state for a
    // capability that registers no server of its own.
    toolPrefixes: ["libi.export_video"],
    npmUrl: null,
    type: "stdio",
    command: "",
    args: [],
    requireApproval: false,
    core: false,
    // No server to spawn — the work runs inside libi's own export job. Same
    // shape as whisper/local-tts/local-music. No `installPlanPath` either:
    // there is no agent-followed plan, libi installs this itself
    // (`lib/export/ensure-chromium.ts`, or the retry chip on this row).
    noServer: true,
    installFlow: "tier-2",
    dependencies: [
      {
        binary: "chromium",
        installFlow: "tier-2",
        // Implementation lives in `installers.ts` (server-only) — keeping the
        // server-only imports (`fs`, `playwright-core`) out of the client
        // bundle that imports bundled.ts via the Settings UI.
        customInstallerId: "playwright-chromium",
        // On demand: the first canvas export (or tracker run) fetches it, and
        // the Settings chip offers Download / Re-download. Without this flag
        // the chip would claim the download "will start automatically" —
        // nothing in Category A ever will.
        manualInstall: true,
      },
    ],
  },
  {
    id: "youtube-download",
    name: "Video download",
    description:
      "Download videos and audio from public pages with yt-dlp, on-device and free. Powers libi.download_video. " +
      `The first download installs uv + yt-dlp (~${YT_DLP_INSTALL_MB} MB). ` +
      "yt-dlp is The Unlicense (public domain); libi installs it on your machine with uv and spawns it like ffmpeg — nothing is redistributed.",
    npmUrl: null,
    kind: "extension",
    toolPrefixes: ["libi.download_video"],
    type: "stdio",
    command: "",
    args: [],
    requireApproval: false,
    // The work runs inside libi's own core MCP (libi.download_video → the
    // video_download job). Nothing is ever spawned for this row.
    noServer: true,
    installFlow: "tier-2",
    dependencies: [
      // uv must install first — the yt-dlp custom installer shells out to it.
      // BOTH deps are tier-2 now: nothing about a download belongs at boot.
      {
        binary: "uv",
        installFlow: "tier-2",
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
            // zip ROOT, not a target directory — astral-sh publishes the
            // Windows build with the executables at the top level.
            win32: "uv.exe",
          },
        },
        // On demand, like libi-export's chromium: the first
        // libi.download_video fetches it (the runner's ensureDep), and the
        // Settings chip offers Download / Re-download. Without the flag the
        // chip would claim the install "will start automatically" — nothing
        // in Category A ever will.
        manualInstall: true,
      },
      {
        binary: "yt-dlp",
        installFlow: "tier-2",
        // `uv tool install yt-dlp` → wrapper in ~/.libi/bin. The
        // YT_DLP_UV_TOKEN force-reinstall lever stays (yt-dlp breaks when
        // YouTube changes its player) — see mcp/registry/installers.ts.
        customInstallerId: "yt-dlp-uv",
        manualInstall: true,
      },
    ],
  },
  {
    id: "libi-tracking",
    name: "Libi Tracking",
    description:
      "Local multi-object tracking engine (boxmot + ONNX). Installed the first time a tracking tool needs it, ~2 GB, on-device.",
    kind: "extension",
    toolPrefixes: [
      "libi.compute_object_track",
      "libi.compute_track_segment",
      "libi.install_tracking_engine",
      "libi.verify_install",
      "libi.list_tracks",
      "libi.list_track_segments",
      "libi.list_identity_candidates",
      "libi.delete_track",
      "libi.ground_target",
      "libi.pick_candidate",
      "libi.skip_segment",
      "libi.update_track_result",
      "libi.add_tracked_overlay",
      "libi.update_tracked_overlay",
      "libi.verify_tracked_overlay",
      "libi.remove_background",
    ],
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
        // MediaPipe Tasks Vision wasm + model assets used by the
        // headless-Chromium face/object tracker (`lib/tracking/track-entry.ts`).
        // Bundled locally so the tracker never depends on jsdelivr / GCS at
        // runtime. Files land under `~/.libi/models/mediapipe-vision/` and are
        // served via `/api/models/[...path]`.
        //
        // tier-2 as of 2026-09-08: 33 MB nobody who never tracks an object
        // should pay at boot. It sits on the tracking extension next to
        // tracking-pyenv, but it is NOT gated behind it — `ensureDep(
        // "libi-tracking", "mediapipe-vision")` brings this one dep alone
        // onto disk (a no-op once it is there), which is what the tracker
        // (`lib/tracking/mediapipe-runner.ts#getBrowser`) calls before every
        // Chromium launch.
        //
        // `pinnedInstallToken` is the @mediapipe/tasks-vision npm tag the
        // URLs point to. Bump this when changing any file URL so users
        // re-fetch — without it, file-existence checks would keep the old
        // assets forever.
        binary: "mediapipe-vision",
        installFlow: "tier-2",
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
      // tracking-pyenv's installer runs `uv sync --locked` through
      // `uvPath()` (lib/tracking/engine-deps.ts), which falls back to a bare
      // "uv" when <LIBI_HOME>/bin/uv is absent — ENOENT on a fresh machine
      // without a system uv. Until 2026-09-08 uv was a tier-1 dep and boot
      // had already put it in bin/; now this def has to declare it itself.
      // Two callers rely on the declaration: `ensureMcp` (standard deps
      // install before custom installers) and the tracking_engine_install
      // job, which `ensureDep`s uv explicitly because it calls `retryDep`
      // on the pyenv dep directly and bypasses that loop. Same spelling as
      // the other uv entries (whisper/yt-dlp/…); install-token dedup makes
      // the duplicate idempotent.
      {
        binary: "uv",
        installFlow: "tier-2",
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
            // zip root, not a target directory — see the uv dep on
            // youtube-download.
            win32: "uv.exe",
          },
        },
      },
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
      "Local, free speech-to-text via faster-whisper. Default transcript provider — no API key, runs on-device. Transcription executes inside libi's analysis pipeline. It is the only transcript service libi has: for anything it cannot do (diarization, say), use a transcription provider you have connected yourself — libi.list_providers shows what that is, libi.suggest_provider({ kind: \"transcription\" }) how to connect one.",
    kind: "extension",
    toolPrefixes: ["libi.whisper_", "libi.analysis_transcribe_audio"],
    npmUrl: null,
    type: "stdio",
    command: "",
    args: [],
    noServer: true,
    requireApproval: false,
    installFlow: "tier-2",
    installPlanPath: "mcp/bundled-mcps/plans/whisper.md",
    dependencies: [
      // uv runs faster-whisper via `uv run --with`. tier-2 as of 2026-09-08 —
      // uv is 52 MB and only a user who reaches this extension needs it
      // (shared with yt-dlp; install-token dedup makes the duplicate
      // idempotent).
      {
        binary: "uv",
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
      "The transcript provider on libi's side — libi.analysis_transcribe_audio({ fileId }) runs local Whisper only. " +
      'If it returns status:"needs_install", run libi.get_install_plan({ mcpId: "whisper" }) and follow it, then retry. ' +
      "If transcript accuracy is poor, call libi.whisper_list_models and suggest a larger model to the user; only " +
      "download medium/large after the user confirms via libi.whisper_download_model.",
  },
  {
    id: "local-tts",
    name: "Local TTS (Kokoro)",
    description:
      "Local, free text-to-speech via Kokoro-82M. Default speech provider — no API key, runs on-device. Synthesis runs inside libi via libi.generate_speech. libi has no voice-cloning service of its own: for a cloned voice, use a voice provider you have connected yourself — libi.list_providers shows what that is, libi.suggest_provider({ kind: \"voice\" }) how to connect one.",
    kind: "extension",
    toolPrefixes: ["libi.tts_", "libi.generate_speech"],
    npmUrl: null,
    type: "stdio",
    command: "",
    args: [],
    noServer: true,
    requireApproval: false,
    installFlow: "tier-2",
    installPlanPath: "mcp/bundled-mcps/plans/local-tts.md",
    dependencies: [
      // uv runs kokoro-onnx via `uv run --with`. tier-2 as of 2026-09-08 —
      // uv is 52 MB and only a user who reaches this extension needs it
      // (shared with yt-dlp/whisper; install-token dedup makes the
      // duplicate idempotent).
      {
        binary: "uv",
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
      "Use libi.tts_list_voices to pick or suggest a different voice. libi cannot clone a voice: when the user asks for a specific cloned voice, use a voice provider THEY have connected (libi.list_providers), or call libi.suggest_provider({ kind: \"voice\" }) when there is none — never assume one exists.",
  },
  {
    id: "local-music",
    name: "Local Music (ACE-Step)",
    description:
      "Local, free music generation via ACE-Step (Apache-2.0). Default music provider — no API key, runs on-device. Generation runs inside libi via libi.generate_music. Paid/licensed music remains available on explicit request.",
    kind: "extension",
    toolPrefixes: ["libi.music_", "libi.generate_music"],
    npmUrl: null,
    type: "stdio",
    command: "",
    args: [],
    noServer: true,
    requireApproval: false,
    installFlow: "tier-2",
    installPlanPath: "mcp/bundled-mcps/plans/local-music.md",
    dependencies: [
      // uv runs acestep via `uv run --with`. tier-2 as of 2026-09-08 — uv
      // is 52 MB and only a user who reaches this extension needs it
      // (shared with whisper/local-tts/yt-dlp; install-token dedup makes
      // the duplicate idempotent).
      {
        binary: "uv",
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
      "Pass that prompt back to ANY music generator — libi.generate_music, or a " +
      "music provider the user has connected themselves (libi.list_providers) — " +
      "to make 'similar' music. " +
      'On { status: "needs_install" } from either analysis tool, call ' +
      "libi.get_install_plan({ mcpId: 'local-music' }) and follow Section B " +
      "(the analyze env is independent from the ACE-Step weights and has its own gate). " +
      'On { status: "insufficient_memory" }, free RAM and retry; analyze needs ~1 GB free.',
  },
];

export const BUNDLED_MCP_SERVERS: BundledMcpDef[] = [...STATIC_BUNDLED_MCP_SERVERS];

/** Every libi-owned extension (everything that is not the core server). */
export const EXTENSION_MCP_SERVERS: BundledMcpDef[] = BUNDLED_MCP_SERVERS.filter(
  (d) => d.kind === "extension",
);

/**
 * The extension that owns `name`, or null. `name` is the REGISTERED tool name
 * (`libi.generate_music`), not the wire name (`mcp__libi-app__libi_generate_music`)
 * — callers canonicalize first via `fromAnyToolName` + `parseMcpToolId`.
 *
 * The longest matching prefix wins so `libi.music_download_model` cannot be
 * claimed by a shorter prefix another extension might later declare.
 */
export function extensionForToolName(name: string): BundledMcpDef | null {
  let best: { def: BundledMcpDef; len: number } | null = null;
  for (const def of EXTENSION_MCP_SERVERS) {
    for (const prefix of def.toolPrefixes) {
      if (!name.startsWith(prefix)) continue;
      if (!best || prefix.length > best.len) best = { def, len: prefix.length };
    }
  }
  return best?.def ?? null;
}
