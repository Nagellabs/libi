export interface BundledSkillRef {
  id: string;
  name: string;
  description: string;
}

export const BUNDLED_SKILLS: BundledSkillRef[] = [
  {
    id: "ai-asset-generation",
    name: "ai-asset-generation",
    description:
      "Generate AI images, videos, audio, music, or 3D assets via configured generation MCPs. Speech/voiceover defaults to local Kokoro TTS and music defaults to local ACE-Step (both free, on-device, no key); paid providers are opt-in. Picks the provider, gathers requirements, builds a detailed prompt, runs the generation, and imports the output as a file on the piece.",
  },
  {
    id: "ugc-product-video",
    name: "ugc-product-video",
    description:
      "Walks the user through creating a UGC-style AI product video — character + product references, scripted beats, per-shot generation, extension, stitching, voiceover, captions, end card.",
  },
  {
    id: "ugc-craft",
    name: "ugc-craft",
    description:
      "Internal craft reference for UGC video generation: the 9-layer UGC formula, clip-duration methodology, pacing / natural-motion / skin-realism cue banks, character-consistency phrasing, and negative-prompt + forbidden-word lists. Loaded BY ugc-product-video and stitching-multi-clip — NOT a standalone entry point. If the user wants a UGC / product / demo / social video, start from ugc-product-video (or stitching-multi-clip for a source+AI stitch).",
  },
  {
    id: "ai-video-models",
    name: "ai-video-models",
    description:
      "Per-engine prompting guides for AI video models (Seedance 2.0, Veo 3.1, Kling). " +
      "Genre-neutral engine rules (reference-image token, prompt order, length, motion, FLF, " +
      "duration caps). Loaded BY ugc-product-video / generic-video — " +
      "not a standalone entry point.",
  },
  {
    id: "realistic-image-generation",
    name: "realistic-image-generation",
    description:
      "Generate realistic AI images — photoreal people / creator portraits and video KEYFRAMES " +
      "(start/end frames). Owns the realism model picker (gpt-image-2 default, never let " +
      "recommend_model downgrade it), anti-'AI-look' tokens + Flux negatives, the UGC selfie + " +
      "demographic templates, the anatomy plausibility pre-check, and the post-generation image " +
      "validation rubric. Loaded BY the Storyboard keyframe step / ugc-product-video / " +
      "generic-video — produces ONE good image; the board sequences keyframe→clip. Not a " +
      "standalone entry point.",
  },
  {
    id: "physical-action-video",
    name: "physical-action-video",
    description:
      "Make hard physical-action / manipulation video beats survive generation — applying, " +
      "peeling, pressing, pouring, gripping-and-releasing, twisting. Owns the FLF-first " +
      "(first-last-frame) approach, prompt decomposition (3–5 one-verb sub-steps, object " +
      "anchoring, affordance pre-conditions), the model-escalation ladder, the editorial " +
      "before/after fallback, and the levers that keep isolated clips looking like ONE video. " +
      "Loaded BY ugc-product-video / generic-video / production-routes when a beat manipulates " +
      "an object. Not a standalone entry point.",
  },
  {
    id: "voiceover-production",
    name: "voiceover-production",
    description:
      "The authority on AI-video audio + voice DURING GENERATION. Native audio is ON by default on every AI clip (generate_audio=true); multi-clip voice consistency is carried via Seedance reference-to-video (@Audio1), NEVER by muting clips + layering a TTS voiceover. Replacing or changing the voice on an EXISTING video is a separate, user-triggered flow — the voice-replacement skill. Loaded BY ugc-product-video / generic-video / mimic-video / stitching-multi-clip — not a standalone entry point.",
  },
  {
    id: "voice-replacement",
    name: "voice-replacement",
    description:
      "Change / replace / re-voice / dub the voice on one or more EXISTING videos in a piece — a deliberate, user-triggered step AFTER the video exists (\"change the voice\", \"give it a different voiceover\", \"redo the voice\", \"dub this\", \"clone my voice over it\", \"new narrator\"). Transcribes the target scenes, asks whether to clone the original voice or pick a new one, lip-syncs the sections where a character speaks on camera, and mutes + re-voices the rest. NOT initial generation (that keeps native audio via voiceover-production). A standalone entry point with its own trigger.",
  },
  {
    id: "stitching-multi-clip",
    name: "stitching-multi-clip",
    description:
      "Build a multi-clip timeline from N independently-generated short video clips as SEPARATE per-beat scenes. The editor's playback engine smooths the clip-boundary seams; concatenation into one file is a FINAL-EXPORT concern, not a way to fix preview jumps. Also owns the single-character continuity rule for source+AI stitches.",
  },
  {
    id: "using-character-library",
    name: "using-character-library",
    description:
      "Catalog and reuse recurring characters and items across pieces — when to suggest saving, how to disambiguate, and how to link assets.",
  },
  {
    id: "audio-analysis",
    name: "audio-analysis",
    description:
      "Transcribe a video or audio file. Default is local Whisper (free, on-device, word-level timing). ElevenLabs is opt-in for speaker diarization/audio-events or on explicit request. BYO STT via per-chunk save tools. Use whenever the user asks for a transcript, captions, or speech-to-text.",
  },
  {
    id: "video-analysis",
    name: "video-analysis",
    description:
      "Analyze a video's visual content — extract keyframes, describe each, and produce a structured summary. Cross-references audio-analysis for the transcript step.",
  },
  {
    id: "using-storyboard",
    name: "using-storyboard",
    description:
      "Use when building or planning a multi-scene video via the Storyboard (the editor's Storyboard tab) — including mimic/recreate flows and any time you'd otherwise write a piece script. Teaches the free schematic tier, the per-endpoint generation spec + model-schema cache workflow (cache-gate → populate → set spec → validate → fix), keyframing/reference/audio params, live continuity references between scenes, and versioned takes.",
  },
  {
    id: "video-planning",
    name: "video-planning",
    description:
      "Think like a senior video editor BEFORE generating — reverse-engineer a target video into its building blocks and build algorithm, turn it into an explicit reviewable plan, then direct the build through the Storyboard, loading the right craft specialist per block. Resolves three entry modes (extract a plan from a demo video · reuse a saved recipe skill · create a fresh plan) and offers to capture a liked plan as a reusable skill. Loaded BY mimic-video and every creation skill (generic-video, ugc-product-video, music-video-creation) — the planning/director layer ABOVE the Storyboard. Not a standalone entry point.",
  },
  {
    id: "using-effects",
    name: "using-effects",
    description:
      "Apply tasteful in/out/loop animation effects to any layer — captions, stickers, logos, backgrounds, audio.",
  },
  {
    id: "using-object-tracking",
    name: "using-object-tracking",
    description:
      "Pin any visual element (emoji, text, image, video, JS draw fn, blur/pixelate/mask) to a moving subject across a video — face or object tracking, censor a face, follow a product — plus the shot-segmented diagnostic + repair loop. Single source of truth for tracking. Triggers: \"smiley on her face\", \"blur the license plate\", \"logo on his shirt\", \"name tag follows him\", \"pixelate the plate\".",
  },
  {
    id: "removing-and-replacing-backgrounds",
    name: "removing-and-replacing-backgrounds",
    description:
      "Remove a video's or photo's background into a reusable alpha cutout asset, then " +
      "compose it over a new background or transplant it into another video. Local free " +
      "MatAnyone matting for video (libi.remove_background), paid fal fallback (bria video / " +
      "birefnet photos). Triggers: \"remove the background\", \"put her on a beach\", " +
      "\"green screen this\", \"cut out the product\", \"transparent background\".",
  },
  {
    id: "music-creation",
    name: "music-creation",
    description:
      "Interview-style music generation. Asks the user about genre, vocals, lyrics, " +
      "length, optional reference track — then dispatches via ai-asset-generation. " +
      "If the user supplies a reference track, calls libi.music_profile first to seed " +
      "the answers.",
  },
  {
    id: "music-video-creation",
    name: "music-video-creation",
    description:
      "Build a music video — generate a track, attach it under the visuals, render " +
      "synced lyrics on screen, and iterate cleanly. Delegates the interview to " +
      "music-creation and transcription to audio-analysis; owns the composition " +
      "rules that prevent stale text, double-rendered lyrics, off-by-200ms caption " +
      "sync, and 'I don't see anything' surprises.",
  },
  {
    id: "mimic-video",
    name: "mimic-video",
    description:
      "Dispatcher for recreating / mimicking an existing video. Analyzes the source via " +
      "video-analysis, classifies it, and routes to a creation skill (ugc-product-video for " +
      "ads, music-video-creation for music videos, generic-video otherwise). Generates nothing " +
      "itself. Triggers: \"recreate this video\", \"make one like this\", \"same video but …\".",
  },
  {
    id: "mimic-video-captions",
    name: "mimic-video-captions",
    description:
      "Reproduce / mimic the ON-SCREEN CAPTIONS of an existing video — lyric typography, kinetic " +
      "text, road/perspective captions, glowing animated subtitles. Splits the two sources " +
      "(Whisper transcript for exact words+timing; a caption-focused paid analysis " +
      "(extra_analysis_model focus:captions) for treatment+motion), routes each caption to " +
      "three-overlays (3D) / animated-text-overlays (flat kinetic) / speech-captions (plain), and " +
      "runs the render-verify loop so captions can't ship out of frame or blank. Loaded by " +
      "mimic-video when captions are part of the recreate; also a direct entry point.",
  },
  {
    id: "generic-video",
    name: "generic-video",
    description:
      "Genre-agnostic AI video creation — recreate a source (handed over by mimic-video) or " +
      "build from a brief. Owns the intake (fidelity, style, pacing, duration, " +
      "stitch-vs-fully-AI, model, voice) and the build flow; references ugc-craft, " +
      "ai-video-models, and ai-asset-generation. Not for UGC ads (ugc-product-video) or music " +
      "videos (music-video-creation).",
  },
  {
    id: "using-snapshot-draft",
    name: "using-snapshot-draft",
    description:
      "Use whenever you mutate a piece's composition or when the user asks to \"go back,\" \"undo,\" \"save,\" \"discard,\" or talks about prior versions. Teaches the snapshot/draft mental model: every edit lands in the draft; commit promotes to snapshot; discard reverts; restore_snapshot recovers a prior committed state.",
  },
  {
    id: "using-asset-folders",
    name: "using-asset-folders",
    description:
      "Use when generating or uploading MULTIPLE related assets — an extend chain, several concept/style variations of one image or video, or a batch of takes — and you want them grouped instead of flooding the piece with loose files. Teaches the one-file-one-asset model plus asset folders: create_asset_folder once, then upload each file with that folderId; move_asset / move_asset_folder to reorganize; delete_asset_folder (orphan vs cascade). There are no \"options\" or a \"default file\" anymore.",
  },
  {
    id: "using-piece-duplication",
    name: "using-piece-duplication",
    description:
      "Use when the user wants multiple versions of a video, several videos about one subject, or a safe place to try a fundamentally different creative direction.",
  },
  {
    id: "installing-mcps",
    name: "installing-mcps",
    description:
      "Use when the user asks you to install, set up, configure, repair, or fix an MCP server. Drives the get_install_plan → follow plan → update_dep_status → verify_install flow with appropriate progress updates.",
  },
  {
    id: "animated-text-overlays",
    name: "animated-text-overlays",
    description:
      'Add or FIX an ANIMATED text overlay — text that reveals or moves over time (typewriter / letter-by-letter, word-by-word fade, slide-up, pop, gradient shine, lower-third, kinetic hook / title / caption). Load this BEFORE hand-writing any code overlay (add_overlay kind code) that animates text — it owns the element-local timing contract that prevents the "only the first few letters show" reveal bug. Triggers — "make the caption type out", "animate the caption", "letter-by-letter typewriter", "kinetic hook", "the animated caption is broken / cut off". NOT for subtitles synced to speech (use speech-captions); NOT for plain static text (use add_overlay kind text).',
  },
  {
    id: "animating-overlays",
    name: "animating-overlays",
    description:
      'Animate an overlay\'s POSITION / SCALE / ROTATION / OPACITY over time with KEYFRAMES — move, slide, zoom, spin, or fade the whole layer from one value to another. Use libi.add_keyframe / libi.set_keyframe_easing so the motion shows as draggable diamonds on the timeline and stays user-editable — never bake transform/opacity motion into a code overlay draw function. Triggers — "make the logo fade in", "slide the title up", "zoom the image in", "spin it", "animate the overlay moving". NOT for repeating wobble/bob/shake/pulse (use an effect); NOT for text characters revealing / typewriter / karaoke (use animated-text-overlays); NOT for bespoke procedural canvas drawing (use a code overlay).',
  },
  {
    id: "speech-captions",
    name: "speech-captions",
    description:
      "Add subtitles/captions synced to spoken audio — read word-level timings (local Whisper STT) and lay readable, time-synced caption overlays in a chosen STYLE (cumulative / word-by-word / karaoke / letter-by-letter). State the style in the result. Use for \"add captions\", \"subtitle this\", \"sync the caption to her speech\". For decorative (non-speech) animated text use animated-text-overlays.",
  },
  {
    id: "three-overlays",
    name: "three-overlays",
    description:
      "Add a real 3D / WebGL (three.js) overlay — perspective captions (text laid on a ground plane, floating billboard text that moves with the camera) and simple animated 3D objects, composited over the layers beneath. Load BEFORE calling libi.add_overlay with kind three (which returns a scene.jsx file you then edit directly). Use when a caption needs DEPTH/PERSPECTIVE that flat Canvas2D code overlays cannot express, or for a simple rotating/animated 3D object. NOT for flat animated text (animated-text-overlays); NOT for speech subtitles (speech-captions); NOT for rigs, physics, or imported heavy 3D models.",
  },
  {
    id: "guiding-manual-edits",
    name: "guiding-manual-edits",
    description:
      "Point the user at the exact overlay inspector control instead of editing it for them — use when the user asks how to change something themselves, or rejects your edit and wants to hand-tweak it. Drives libi.highlight_property (flash a field + reveal its intent-group tab) and libi.set_complexity_mode (switch one overlay's tab: transform/style/text). Load when guiding a manual edit, NOT when the user wants you to make the change.",
  },
  {
    id: "onboarding-libi-explainer-short",
    name: "onboarding-libi-explainer-short",
    description:
      "Run ONLY during first-run onboarding when the user clicks \"show me how it works\" (or asks for the libi intro/demo). Builds libi's own 52-second explainer film into a real piece with a single call to libi.build_onboarding_piece (~15 MB download, no generation), reveals it, then tells the user honestly that the film is pre-made but was itself built in libi and is fully editable — and asks what they want to make.",
  },
];
