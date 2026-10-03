/**
 * What the bundled skills must STATE — never how they say it.
 *
 * These are the product invariants and real failures that skill prose carries: the rules whose
 * absence cost a user money, lost a result, published something, or broke a render. Each is
 * stated by a few tolerant regexes (case-insensitive, no pinned sentence, no heading, no file
 * path) and matched against the whole graph of the skill that owns the rule — SKILL.md plus
 * everything under its folder. So a rewrite may reword the rule, shorten it, or move it into a
 * `references/` file and keep passing; one that drops it fails here, naming the invariant.
 *
 * WHEN A SKILL MOVES OR MERGES, edit ONE place: `SKILL_SUCCESSORS` in
 * `__tests__/helpers/skill-graph.ts` (old name -> the skill that absorbed it). Every name in the
 * tables below keeps working through it; rename an owner here only to say it now lives somewhere
 * other than where its successor mapping points.
 *
 * Behaviour (the agent actually doing these things) is the skill-eval scenarios' job.
 */
import { describe, it, expect } from "vitest";
import {
  SKILL_SUCCESSORS,
  collapse,
  coreText,
  graphText,
  manualText,
  mentionsSkill,
  resolveSkill,
  resolveSkills,
  bodyText,
  skillIds,
} from "../../helpers/skill-graph";
import { toolSurfaceText } from "../../helpers/tool-surface";

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Tables — the single place that says who owns what. Edit here when files move.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/** Places other than a skill where a rule may legitimately live (a skill folded into them, K5). */
type Place = "manual" | "core" | "tools";

interface Invariant {
  /** What the rule is, in a few words. Shown when it fails. */
  name: string;
  /** Skills that own the rule (names resolve through SKILL_SUCCESSORS). A skill folded away (maps to []) is allowed here when `alsoIn` says where it went. */
  in: readonly string[];
  /** Every one of these must match. */
  has: readonly RegExp[];
  /** None of these may match (a removed claim, a forbidden fallback). */
  lacks?: readonly RegExp[];
  /**
   * How several owners combine. "joined" (default): their graphs are read as one text, so the rule may live in
   * any of them. "each": EVERY owner must state it itself — for a rule each skill has to carry because the agent
   * may load only that skill (the paid-generation disclosure, the key rule).
   */
  scope?: "joined" | "each";
  /**
   * Files (relative to the skill folder) that must EACH state the rule on their own, for every owner. For a rule
   * the agent can meet in only one of two places — the injection defence is read from SKILL.md when a template is
   * created and from references/applying-safely.md while it is applied.
   */
  eachFile?: readonly string[];
  /** Also accept the rule in the manual source, the core instructions, or the tool descriptions (joined with the graph). */
  alsoIn?: readonly Place[];
  /** A structural check over the text the regexes saw (ordering, for example). Returns the problems it found. */
  check?: (text: string) => string[];
}

const inv = (
  name: string,
  owners: string | readonly string[],
  has: readonly RegExp[],
  lacks: readonly RegExp[] = [],
  extra: Pick<Invariant, "scope" | "eachFile" | "alsoIn" | "check"> = {},
): Invariant => ({ name, in: typeof owners === "string" ? [owners] : owners, has, lacks, ...extra });

/** An owner that was folded into the manual and the tool descriptions has no skill left: it maps to []. */
const isFolded = (owner: string) => SKILL_SUCCESSORS[owner]?.length === 0;

/** The text of one owner's graph, or of one named file of it. */
const ownerText = (owner: string, file?: string): string => {
  const skills = resolveSkills([owner]);
  if (!file) return graphText([owner]);
  return collapse(
    skills
      .flatMap((x) => x.files)
      .filter((f) => f.rel === file)
      .map((f) => f.text)
      .join("\n\n"),
  );
};

/** The extra places a rule may live, as one text. */
async function placesText(places: readonly Place[] = []): Promise<string> {
  const parts: string[] = [];
  if (places.includes("manual")) parts.push(collapse(manualText()));
  if (places.includes("core")) parts.push(collapse(coreText()));
  if (places.includes("tools")) parts.push(await toolSurfaceText());
  return parts.join("\n\n");
}

/** What one invariant is matched against, as labelled slices (one slice for "joined", one per owner/file otherwise). */
async function slicesFor(i: Invariant): Promise<Array<{ label: string; text: string }>> {
  const extra = await placesText(i.alsoIn);
  const withExtra = (t: string) => (extra ? `${t}\n\n${extra}` : t);
  if (i.eachFile) {
    return i.in.flatMap((o) => i.eachFile!.map((f) => ({ label: `${o}/${f}`, text: ownerText(o, f) })));
  }
  if (i.scope === "each") return i.in.map((o) => ({ label: o, text: ownerText(o) }));
  return [{ label: i.in.join(" + "), text: withExtra(graphText(i.in)) }];
}

// Names used below, so a move is one edit.
const GEN = "ai-asset-generation";
// video-generation-craft holds the engine guides (references/engines/*), the physical-action, realistic-images and voice
// references: the four former skills (ai-video-models, physical-action-video, realistic-image-generation,
// voiceover-production) are one graph now, so these names are aliases of it.
const CRAFT = "video-generation-craft";
const VOICE = CRAFT;
const ENGINES = CRAFT;
const PHYSICAL = CRAFT;
const IMAGES = CRAFT;

const INVARIANTS: readonly Invariant[] = [
  // ── Generation: audio, voice, text ────────────────────────────────────────────────────────
  inv("native audio stays ON for AI video; muting an AI generation is a defect", [GEN, VOICE], [
    /generate_audio\s*=\s*true/i,
    /(never|do not|don't)[\s\S]{0,60}\bmut(e|ing)\b|\bmut(e|ing)\b[\s\S]{0,60}defect/i,
    // A clip that is going to be silenced must not be given spoken lines (the dialogue and the audio must agree).
    /never write (dialogue|spoken lines) into a clip you are silenc/i,
  ]),
  inv("multi-clip voice is carried by a reference-conditioned generation (@Audio1), never a muted-clips-plus-TTS layer, never substituted silently", [VOICE, ENGINES], [
    /reference-conditioned/i,
    /@Audio1/,
    /@Image1/,
    // The prohibition itself, not a mention of TTS: "do not mute the clips and layer a TTS voiceover" / "a TTS tool is not a substitute".
    /(never|do not|don'?t)[\s\S]{0,60}\bmut(e|ing)\b[\s\S]{0,60}(layer|lay|add)[\s\S]{0,40}TTS|TTS[\s\S]{0,60}not a substitute/i,
    /ask (the user )?first|always ask|surface (it )?to the user|explicit (user )?opt-in/i,
    /(do not|never|don'?t)[\s\S]{0,40}(silently )?(auto-?)?substitut[\s\S]{0,20}(a )?VO|(do not|never)[\s\S]{0,30}silently substitute/i,
  ], [
    // The regressions this skill exists to stop: a separate-voice fallback offered by an engine guide or a generating skill.
    /fall back to a single [\w ]*VO/i,
    /mute the clips,\s*one EL voice/i,
    /suggest_provider\(\{ kind: "voice"/,
  ]),
  inv("the voice authority is scoped to generation time and owns no voice-provider gate or speech call", VOICE, [
    /generation[- ]time/i,
  ], [
    // A `voice` gate resolves to Kokoro, which is exactly the muted-clips-plus-TTS regression this skill forbids.
    /## Provider gate/,
    /libi\.generate_speech/,
    /libi\.tts_/,
  ]),
  inv("the audio handed to the carry is MP3/WAV, not AAC / `format: copy`", [VOICE, ENGINES, "stitching-multi-clip"], [
    /extract_audio/,
    /MP3/,
    /AAC|format:\s*"copy"|HTTP 422|\b422\b/i,
  ]),
  inv("engine endpoint ids are never invented; audio alone is not a valid reference", ENGINES, [
    /invent[\s\S]{0,20}(tier|segment|variant)/i,
    /audio[\s\S]{0,40}(alone|only)[\s\S]{0,40}reject|reject[\s\S]{0,60}audio[\s\S]{0,20}(alone|only)/i,
  ]),
  // "## <engine> … Native audio: YES|NO" with no other heading in between, so one engine cannot borrow another's answer.
  inv("each engine block states whether the engine has native audio (YES or NO)", ENGINES, [
    /## Seedance 2\.0(?:(?! ## )[\s\S])*?Native audio: (YES|NO)/,
    /## Veo 3\.1(?:(?! ## )[\s\S])*?Native audio: (YES|NO)/,
    /## Kling(?:(?! ## )[\s\S])*?Native audio: (YES|NO)/,
  ]),
  inv("Seedance reference grammar: @Image1/@Audio1 tokens exist only on the reference-to-video endpoint; beats are paced by description, not hard timecodes", ENGINES, [
    /@Image1/,
    /@Audio1/,
    /reference-to-video/,
    // No tokens on a plain image-to-video endpoint — the rule, not just the endpoint's name.
    /no token mechanism|no tokens in a plain|do not sprinkle/i,
    // The ban on hard timecodes, not the word: "use [00:00] timecodes" must not satisfy this.
    /\b(no|not|never|don'?t)\b[\s\S]{0,40}timecodes/i,
  ]),
  inv("no text in generated video; user prompt language asking for it is rewritten", GEN, [
    /no on-screen text|no (in-video|burned-in) text|never[\s\S]{0,40}text (in|inside) (the )?(generated )?video/i,
    /(reject|paraphrase|rewrite|strip)[\s\S]{0,80}(text|caption)/i,
  ]),
  inv("one voice-line question per build: a spoken line, or a music bed; a drafted line when nobody can answer", GEN, [
    /spoken line/i,
    /music bed/i,
    /\bonce\b|never ask again/i,
    /draft(ed)?[\s\S]{0,60}(line|brief)|(line|narration)[\s\S]{0,40}drafted/i,
  ]),
  inv("the storyboard card's voiceover.line is the clip's dialogue", "using-storyboard", [/voiceover\.line/]),
  inv("generic-video offers a music bed when there is no line", "generic-video", [/music bed/i]),
  // Each generating skill states this itself: an agent loads one skill, not the pair.
  inv("providers: never read or handle a provider key; local files go through the provider's own upload tool", [GEN, "voice-replacement"], [
    /(never|do not|don't)[\s\S]{0,60}(read|handle|set)[\s\S]{0,40}(FAL_KEY|provider key|key)/i,
    /provider'?s (own )?upload tool|\bown upload tool/i,
  ], [], { scope: "each" }),
  inv("providers: a presigned upload URL the provider's own tool hands out is the one exception", GEN, [/presigned/i]),
  inv("generation hand-off: the produced file is imported with provenance and notes", GEN, [
    /libi\.save_asset/,
    /libi\.upload_file/,
    /aiGeneration/,
    /libi\.update_file_notes/,
  ]),
  // Each skill that spends money says so itself; the core instructions repeat the rule (checked below).
  inv("paid generation: disclose the cost and get a yes first", [GEN, "voice-replacement"], [
    /disclos[\s\S]{0,80}(cost|price)|(cost|price)[\s\S]{0,80}disclos/i,
    /approval|a yes|confirm|ask (the user )?first/i,
  ], [], { scope: "each" }),

  // ── ElevenLabs hosted server: the rules that cost money or lose the result ────────────────
  inv("ElevenLabs: one generation per call, priced with estimate_only, confirmed first", GEN, [
    /generations_count:\s*`?1/,
    /estimate_only/,
    /wait for a yes|approval|confirm/i,
  ]),
  inv("ElevenLabs: poll with poll_after_seconds; the output URL is short-lived — download at once", GEN, [
    /poll_after_seconds/,
    /short-lived/i,
    /creative_get_flow_run_status/,
  ]),
  inv("ElevenLabs: voice_id comes from the voice list, never invented; the agents_* tools are not for generation", GEN, [
    /creative_list_voices/,
    /(never|do not)[\s\S]{0,20}(invent|guess|make up)[\s\S]{0,20}`?voice_id/i,
    /agents_\*/,
  ]),
  inv("ElevenLabs voice changer / music calls also carry generations_count: 1", ["voice-replacement", "music-creation"], [
    /generations_count:\s*`?1/,
  ], [], { scope: "each" }),
  inv("ElevenLabs result shape: audio is in media[], keyed by generation_id; transcripts are flat text", GEN, [
    /media\[\]/,
    /generation_id/,
    /transcripts\[\]/,
  ]),

  // ── Image + physical-action craft ─────────────────────────────────────────────────────────
  inv("realism images: a recommendation tool never downgrades the realism model; anatomy pre-check; validate after", IMAGES, [
    /downgrade/i,
    /plausib/i,
    /validat/i,
  ]),
  inv("physical action: FLF first, decompose into one-verb steps, escalate only the failing beat, start hard beats at the strong model, disclose the cost", PHYSICAL, [
    /first-last-frame|\bFLF\b/i,
    /decompos/i,
    // The shape of the ladder, not the word "escalate": a ladder that climbs for the whole ad costs real money.
    /escalate only the failing beat|escalate (that|the failing) beat/i,
    /start at the\s+strong model/i,
    /disclose[\s\S]{0,60}(higher )?(per-second )?cost[\s\S]{0,40}before escalating|cost[\s\S]{0,80}disclos/i,
  ]),
  // Across four scenario runs the agent never opened the provider reference, and invented an endpoint instead.
  inv("physical action: the provider reference is read before the first provider call", PHYSICAL, [
    /\bread\b[\s\S]{0,20}`?references\/providers\/<id>\.md`?[\s\S]{0,60}\bbefore (your|the) first provider\s+call/i,
  ]),
  inv("FLF keyframe field names differ per engine and come from the schema", [PHYSICAL, ENGINES], [
    /first_frame_url/,
    /last_frame_url/,
    /start_image_url/,
    /end_image_url/,
    /differ per engine|no universal|not universal/i,
    /get_model_schema/,
  ]),

  // ── Voice replacement ─────────────────────────────────────────────────────────────────────
  inv("voice replacement: ask clone vs new voice; lip-sync on talking faces; mute (never delete) the original; cover the real speech", "voice-replacement", [
    /clone/i,
    /new voice/i,
    /lip-?sync/i,
    /enabled:\s*false/,
    /(never|not)\s+(delete|`?audio_remove_clip`?|action\s+`?remove`?)|never delete/i,
    /cover[\s\S]{0,60}speech|speech[\s\S]{0,60}cover|actual[\s\S]{0,20}speech/i,
    /libi\.update_overlay/,
    /Kokoro/,
    // The swap re-times the inline clip but never re-links it: the talking-face path must mute it AND add the synced audio.
    /never re-links/i,
    /audio_add_clip[\s\S]{0,40}<synced file id>/,
    /exactly one audible voice/i,
    /suggest_provider\(\{ kind: "video", reason: "lip-sync"/,
  ], [/set_default_option|sceneOrder/]),

  // ── Backgrounds ───────────────────────────────────────────────────────────────────────────
  inv("background removal: local free path by default; magenta verification; paid fallback needs background_color: Transparent", "removing-and-replacing-backgrounds", [
    /libi\.remove_background/,
    /magenta/i,
    /background_color/,
    /Transparent/,
    /alpha/i,
    /\bfree\b/i,
    /needs no provider|no provider/i,
    // Two traps that cost money or silently lose the alpha: the old endpoint priced ~33x above the current one, and the
    // default background colour returns a black-matted video with no alpha at all.
    /(do not|never)\s+use[\s\S]{0,80}\bv1\b/i,
    /background_color[\s\S]{0,120}defaults? to `?Black/i,
  ]),

  // ── Stitching / ugc / mimic ───────────────────────────────────────────────────────────────
  inv("stitching: one full-frame video overlay per beat; fresh edge frames (face-leak); skin-tone match; clause boundaries; director review", "stitching-multi-clip", [
    /one full-frame video overlay per beat/i,
    /skin tone/i,
    /(extract|re-extract)[\s\S]{0,40}(fresh|boundary|edge)|fresh[\s\S]{0,40}(boundary|edge)[\s\S]{0,20}frames/i,
    /clause|sentence boundar/i,
    /director/i,
    /analysis_extract[\s\S]{0,40}frames/,
  ], [/## Provider gate/, /libi\.suggest_provider/]),
  inv("UGC: one full-length multi-beat clip by default, capped by the model's own per-clip max; recreations pack, not one clip per shot", "ugc-product-video", [
    /multi-beat/i,
    /(model'?s? (own )?|per-)(clip )?(max|cap)/i,
    /fewest|not (one|eight)|never map one/i,
  ]),
  inv("UGC routes: native audio stays on fully-AI paths; a source stitch guards against doubled audio", "ugc-product-video", [
    /native audio/i,
    /double(d)?[- ]audio|audio_remove_clip|audio_clip\b[\s\S]{0,40}remove/i,
  ]),
  inv("UGC: per-project overrides are honoured; the chosen model is verified at runtime; known fast-model and extend traps are recorded", "ugc-product-video", [
    /override/i,
    /verify[\s\S]{0,80}(runtime|schema|provider)/i,
    /no_media_generated/,
    /full (chain|clip)/i,
  ]),
  inv("UGC: Seedance-derived formula files keep the MIT attribution", "ugc-product-video", [/arcads-claude-code \(MIT/]),
  inv("mimic-video: dispatcher generates nothing; flags clip count and the source voice in the hand-off", "mimic-video", [
    /generate nothing|do not generate|generates nothing/i,
    /fewest[\s\S]{0,40}clip|not one clip per source shot/i,
    /reproduce the voice|(do not|never)[\s\S]{0,30}default[\s\S]{0,20}silent/i,
  ]),
  inv("generic-video: intake covers fidelity, duration, voice, stitch-vs-AI; one clip rather than fragments", "generic-video", [
    /fidelity/i,
    /duration/i,
    /voice/i,
    /stitch/i,
    /\bone[- ]clip|fragment|15s/i,
  ]),
  inv("video-analysis: the free agent flow needs no provider; the paid flow runs on the user's provider; recreation goes to mimic-video", "video-analysis", [
    /mimic-video/,
    /analysis_save[\s\S]{0,40}summary/,
    /video_v1/,
    /\bfree\b/i,
    /(your|the user'?s?|own) provider/i,
  ], [/extra_analysis_model/, /## Provider gate/]),
  inv("mimic-video-captions: the paid caption analysis runs on the user's provider; words and timing come from the transcript", "mimic-video-captions", [
    /(your|the user'?s?|own) provider/i,
    /transcript|Whisper/i,
  ], [/libi-core paid tool/]),

  // ── Music + captions ──────────────────────────────────────────────────────────────────────
  inv("music: local ACE-Step is the default; a paid provider is an option, never the agent's own initiative", ["music-creation", GEN], [
    /libi\.generate_music/,
    /ACE-Step/,
    /paid[\s\S]{0,100}(option|only|explicit|asks?|upgrade)|(option|explicit|upgrade)[\s\S]{0,100}paid/i,
    /list_providers/,
  ], [/ELEVENLABS_API_KEY/, /\bFAL_KEY\b[\s\S]{0,20}(export|set)/]),
  inv("music: the paid providers' call shapes are recorded (ElevenLabs flow node, a discoverable Stable Audio model)", "music-creation", [
    /creative_generate_in_flow/,
    /node_type:\s*"music"/,
    /Stable Audio/i,
  ]),
  inv("music: reusing a source video's track is offered, with a licensing caveat", "music-creation", [
    /libi\.extract_audio/,
    /licens/i,
    /libi\.music_profile/,
  ]),
  inv("speech: local Kokoro is the default voice; a cloned voice needs the user's own provider", GEN, [
    /libi\.generate_speech/,
    /Kokoro|local-tts/,
  ]),
  inv("music never changes the piece's length without asking (lengthPolicy)", ["music-creation", "music-video-creation"], [
    /lengthPolicy/,
    /longer than the piece|extend the piece/i,
  ], [], { scope: "each" }),
  inv("music video: one source of truth for on-screen text; no global lead offset; muted original = enabled:false", "music-video-creation", [
    /source of truth/i,
    /lead offset/i,
    /enabled:\s*false/,
    /libi\.music_detect_beats/,
    /(4\+|four)[\s\S]{0,60}generations?/i,
    /approval/i,
  ]),
  inv("transcription: Whisper first; paid STT is ask-first; only word-timed results are saved; no suggest_provider detour for diarization", "audio-analysis", [
    /libi\.analysis_transcribe_audio/,
    /Whisper/,
    /ask first|ask the user/i,
    /word[- ]timings?|word-level/i,
    /Path B|your own STT/i,
    /diariz/i,
  ], [/suggest_provider\(\{ kind: "transcription", reason:/, /provider:\s*"elevenlabs"/]),
  inv("ElevenLabs transcription is flat text: it is given to the user, never saved as chunks, and its speaker-label limits are said plainly", "audio-analysis", [
    /flat text/i,
    // Flat text with no timings is NOT saved as the file's transcript: a save marks the chunks done and the file can never be captioned.
    /flat text[\s\S]{0,80}(is )?not saved|never saved as|(do not|never)[\s\S]{0,30}save[\s\S]{0,60}(flat|no timings|plain text)|only a result that carries word timings/i,
    /(hand|give|relay)[\s\S]{0,40}(text )?(to|instead to) the user|tell the user plainly/i,
    /speaker/i,
  ]),
  inv("transcription: a larger Whisper model is downloaded only after the user confirms (~1.5-3 GB)", "audio-analysis", [
    /\b(medium|large(-v3)?)\b[\s\S]{0,120}only after the user confirms|(confirm|ask)[\s\S]{0,60}(before|then)[\s\S]{0,40}download[\s\S]{0,40}(medium|large)/i,
  ]),

  // ── Overlays, motion, tracking ────────────────────────────────────────────────────────────
  inv("motion is keyframes first (visible, editable) and is never baked into a code overlay", "animating-overlays", [
    /add_keyframe/,
    /(never|not|don't)[\s\S]{0,60}(bake|baked|code overlay)/i,
  ]),
  inv("animated text: element-local timing contract; typewriter etc. here, subtitles elsewhere", "animated-text-overlays", [
    /element-local/i,
    /typewriter/i,
    /speech-captions/,
  ]),
  inv("three.js overlays: build once, update per frame, never create meshes in the update; camera presets; edit scene.jsx directly", "three-overlays", [
    /build[- ]once/i,
    /(never|do not)[\s\S]{0,60}create[\s\S]{0,60}(inside|in) the update|NEVER create them inside/i,
    /progress/,
    /cameraPreset/,
    /ground/,
    /billboard/,
    /roadCaption/,
    /billboardCaption/,
    /simpleObject/,
    /scene\.jsx/,
    /codeFilePath/,
    /rig|physics|glTF/i,
    /animated-text-overlays/,
    /speech-captions/,
    /libi\.add_overlay/,
  ], [/add_three_overlay|update_three_overlay/]),
  inv("tracking: a base video is required; the tracked overlay renders on top; the lazy engine install contract", "using-object-tracking", [
    /base video/i,
    /on top of/i,
    /libi\.add_overlay/,
    /analysis_query[\s\S]{0,40}search_frames/,
    /cannot conjure a subject that isn'?t/i,
    /derivedFromSubjectName/,
    /tracking_engine_not_installed/,
    /verify_install/,
  ], [/list_bundled_mcps/, /analysis_finalize/, /analysis_extract_frame_at/]),
  inv("tracking: zero output is an engine failure — never fake it with hand-made keyframes", "using-object-tracking", [
    /(zero|no) (output|track|tracked)[\s\S]{0,60}(engine )?fail|engine failure/i,
    /(never|do not|forbidden)[\s\S]{0,60}(silently )?(hand-)?(animat|keyframe|fake)/i,
    /ground_target/,
  ]),
  inv("tracking: verify the render before attaching; the verify loop is mandatory", "using-object-tracking", [
    /libi\.tracked_overlay[\s\S]{0,40}verify/,
    /(look at|view|inspect|see)[\s\S]{0,40}frames/i,
    /mandatory|must verify|do not attach/i,
  ]),
  inv("tracking: identity switch means re-anchor, never skip; a subject genuinely gone means skip", "using-object-tracking", [
    /identity_switch_suspected[\s\S]{0,400}re-anchor/i,
    /(never|do not)[\s\S]{0,20}`?skip_segment`?[\s\S]{0,160}wrong[- ]subject/i,
    /(genuinely )?(absent|gone|occluded)[\s\S]{0,200}skip_segment/i,
  ]),
  inv("tracking: agent anchors from compute_segment persist, are honoured, and are not user manual anchors", "using-object-tracking", [
    /compute_segment/,
    /persist|re-seed|honou?red/i,
    /dense/i,
    /transparent|not user-visible|manual[\s\S]{0,60}outrank/i,
    /force[- ]track/i,
  ]),
  inv("tracking: stabilisation — position vs size jitter have different levers; interpolation is not a denoiser", "using-object-tracking", [
    /positionMode/,
    /positionMode:\s*"raw"/,
    /size_jitter/,
    /sizeMode|maxBoxScale/,
    /libi\.tracked_overlay[\s\S]{0,40}update/,
    /NOT a denoiser/i,
    /SIZE problem[\s\S]{0,40}not[\s\S]{0,20}position|not a position problem/i,
  ], [/`catmull-rom` if jittery/, /smoothing: "catmull-rom"/]),
  inv("tracking: faces use objectKind face + fit tight; non-person subjects route automatically; no paid tracker; update_result is boxes-only", "using-object-tracking", [
    /objectKind:\s*"face"/,
    /fit:\s*"tight"/,
    /non-person[\s\S]{0,300}automatic/i,
    /no\s+paid tracking provider/i,
    /update_result[\s\S]{0,400}boxes only/i,
  ], [/refine_track_with_sam2|compute_object_track_providers/, /compute_object_track\b|compute_track_segment|update_track_result|verify_tracked_overlay|add_tracked_overlay|update_tracked_overlay/]),

  // ── Storyboard ────────────────────────────────────────────────────────────────────────────
  inv("storyboard: the schema-cache gate (populate before set_storyboard_generation), keyframe/reference params, one spec per card", "using-storyboard", [
    /model_schema_cache\(\{ action: "get"/,
    /model_schema_cache\(\{ action: "save"/,
    /model_schema_cache\(\{ action: "invalidate"/,
    /schema_cache_missing|cache[\s\S]{0,40}populat/i,
    /set_storyboard_generation/,
    /set_storyboard_reference/,
    /storyboard_take`? action `select`/,
    /start_frame/,
    /end_frame/,
    /reference_video/,
    /GenFieldDef/,
    /every card[\s\S]{0,60}generation spec|generation spec[\s\S]{0,60}every card/i,
  ]),
  inv("storyboard: the card is read fresh before anything is spent", "using-storyboard", [
    /(read|re-read|fresh)[\s\S]{0,80}(card|storyboard)[\s\S]{0,80}(spend|generat|cost|before)|(before|spend)[\s\S]{0,80}(read|re-read)[\s\S]{0,40}card/i,
  ]),
  inv("video-planning: three entry modes, per-block decisions, plan captured as a skill, fewest model-max clips", "video-planning", [
    /Extract/,
    /Reuse/,
    /Create/,
    /combine vs\.? split/i,
    /style inheritance/i,
    /`libi\.skill` action `add`/,
    /reference_video/,
    /fewest/i,
  ]),

  // ── Social: the rules that keep a mistake recoverable ─────────────────────────────────────
  inv("social posting: the wire names are snake_case; never the lossy posts_create; idempotency via metadata.libi.requestId; no headers", "social-posting", [
    /(never|not)[\s\S]{0,20}`?posts_create`?/i,
    /is_draft/,
    /media_items/,
    /tiktok_settings/,
    /dry_run/,
    /metadata\.libi\.requestId/,
    /requestId[\s\S]{0,10}mediaUrl/,
    // Named only to say it is unreachable: an agent that sends the header gets the whole call rejected.
    /x-request-id[\s\S]{0,160}(is not reachable|does not exist|rejected)/i,
    // The echoed media URL dies with the post that references it; the edit must re-send the URL the upload used.
    /(never|do not|don'?t)[\s\S]{0,60}(media )?URL[\s\S]{0,30}provider (echoed|echoes|returned|gave)/i,
    /no `?headers`? argument/i,
    /camelCase/i,
    /budget/i,
    /posts_update_post/,
    /posts_list_posts/,
    /additionalProperties: false/,
    /libi\.social_status/,
    /libi\.post_piece/,
    /libi\.social_link\(\{ kind: "post"/,
    /libi\.suggest_provider/,
    /call_tool/,
    /search_tools/,
    /accounts_get_tik_tok_creator_info/,
    /media_get_media_presigned_url/,
    /validate_post/,
  ], [/## Provider gate — read this first/]),
  inv("social posting: never ask for an API key; publishing needs an explicit yes; post_piece cannot publish; two separate connections", "social-posting", [
    /never ask (the user )?for (a|an) API key/i,
    /explicit(ly)? (yes|approv)/i,
    /cannot publish|never publishes/i,
    /libiConnected/,
  ]),
  inv("social posting: platform limits are recorded", "social-posting", [
    /600 s|10 min/,
    /PUBLIC_TO_EVERYONE/,
    /90 s/,
    /platformSpecificData/,
    /no (safe )?rehearsal|no private/i,
  ]),
  inv("social music: the user alone decides `owned`; relay each target's plan; no claimed match that was not reported", "social-music", [
    /(never|do not|don't)[\s\S]{0,20}set[\s\S]{0,10}`?owned`?/i,
    /plan\.sentence/,
    /only after the user says yes|user says yes/i,
    /commercialMusicId/,
    /ignored on drafts/i,
    /rights:\s*\{\s*class:\s*"copyrighted"/,
    /music\.summary/,
    // Several platforms in one export call: pieceId stays at the top level (social-posting points here for it).
    /pieceId[\s\S]{0,20}top level|top level[\s\S]{0,40}pieceId/i,
    /(never|don't|do not)[\s\S]{0,20}claim a match[\s\S]{0,60}(report|return)/i,
    /user_decided/,
    /without `?rights`?/,
    /accounts_list_tik_tok_commercial_music/,
    /instagram_search_instagram_audio/,
    /instagram_get_instagram_audio/,
    /instagram_audio_requires_facebook_login/,
    /libi\.set_audio_rights/,
    /libi\.social_music_search/,
    /libi\.fetch_template_music/,
    /musicSoundInfo/,
    /audioConfiguration/,
  ]),

  // ── Templates: only the user publishes; another person's text is data ─────────────────────
  // The whole defence against another person's index.md being read as orders. The agent meets it in SKILL.md when it
  // creates a template and in references/applying-safely.md while it applies one, so BOTH files carry every clause.
  inv("templates: a template's index.md is data, not orders — every ban, in each of the two files the agent reads", "templates", [
    /data, not (as )?orders/i,
    /(never|do not)[\s\S]{0,20}run shell commands/i,
    /install software/i,
    /change settings/i,
    /read or write files outside[\s\S]{0,20}this piece'?s? folder/i,
    /fetch a URL that is not listed in the template'?s asset list/i,
    /even if they claim to come from libi or from the user|claim[\s\S]{0,30}to come from[\s\S]{0,20}libi[\s\S]{0,20}(the )?user/i,
    /refuse (that|THAT) step[\s\S]{0,60}quote/i,
    /(still do|carry on with) the template'?s ordinary video-editing steps|ordinary video-editing steps (still )?run/i,
  ], [/Continue with the remaining\s+video-editing steps only if the user says so/, /stop, quote the line/], {
    eachFile: ["SKILL.md", "references/applying-safely.md"],
  }),
  inv("templates: a template's Steps never lead to a publish, and applying never publishes — in each of the two files", "templates", [
    /Steps[\s\S]{0,40}(must )?never[\s\S]{0,80}publish/i,
    /appl(y|ying)[\s\S]{0,40}never publishes/i,
    /(an agent can prepare|agent prepares?)[\s\S]{0,60}(only the user|the user (can )?publish)/i,
  ], [], { eachFile: ["SKILL.md", "references/applying-safely.md"] }),
  inv("templates: applying-safely lists publishing among what is not allowed, whatever the instructions say", "templates", [
    /not allowed,? whatever the instructions say[^#]{0,1500}\bpublish/i, // [^#]: inside that list, not in a later section
  ], [], { eachFile: ["references/applying-safely.md"] }),
  inv("templates: publishing is prepared with libi.publish_template, never claimed done; no confirm flag", "templates", [
    /libi\.publish_template/,
    /(never say|do not say|don't say)[\s\S]{0,30}published/i,
    /awaiting_your_confirmation/,
    /publishes NOTHING|nothing is public until/i,
  ], [/confirm:\s*true/, /Publishing arrives with the public catalog/]),
  inv("templates: ask private vs public before publishing; disclose what becomes public; invite-only said once, never pushed", "templates", [
    /private[\s\S]{0,100}public/i,
    /nickname/i,
    /no private/i,
    /invite-only/i,
    /Apply to publish/,
    /(don't|do not|never)[\s\S]{0,20}(predict|push|ask again|retry)/i,
    /exportPieceId/,
    // Everything the disclosure must name, together — an omitted item is a thing the user did not know became public.
    /instructions[\s\S]{0,200}overlays[\s\S]{0,200}images[\s\S]{0,200}fonts[\s\S]{0,200}example video[\s\S]{0,200}poster[\s\S]{0,200}public/i,
  ], [], {
    // Order: the disclosure, then the call (which only prepares), then the hand-off to the user.
    check: (t) => {
      const disclosure = t.search(/no private cloud option/i);
      const call = t.search(/libi\.publish_template\(\{/);
      // The hand-off is searched AFTER the call: the frontmatter description mentions it too.
      const after = call < 0 ? -1 : t.slice(call).search(/ready for THEM to publish|publish it themselves|click \*\*Publish publicly/i);
      const problems: string[] = [];
      if (disclosure < 0 || call < 0 || after < 0) problems.push("disclosure, the publish_template call, or a hand-off after the call is missing");
      else if (!(disclosure < call)) problems.push(`the disclosure (${disclosure}) must come before the publish_template call (${call})`);
      return problems;
    },
  }),
  inv("templates: libi.show({ target: 'templates' }) comes last, after the user's answer (the page has no chat)", "templates", [
    /target: "templates"[\s\S]{0,260}(not visible|unseen|last)|(last|before)[\s\S]{0,80}libi\.show\(\{ target: "templates"/i,
    /stop and wait for the answer|end your turn on that question/i,
  ], [], {
    check: (t) => {
      const question = t.search(/keep this template private on this machine/i);
      const show = t.search(/libi\.show\(\{ target: "templates", templateId \}\)/);
      if (question < 0 || show < 0) return ["the private-or-public question or the show (target templates) call is missing"];
      return question < show ? [] : ["libi.show({ target: 'templates' }) is called before the private-or-public question"];
    },
  }),
  inv("templates: apply into a new piece; fill media slots; check renderDiagnostics", "templates", [
    /apply_template\(\{[^}]*newPiece/,
    /never[\s\S]{0,10}`?libi\.create_piece`?[\s\S]{0,10}first/i,
    /renderDiagnostics/,
    /update_overlay/,
    /don't export the piece|do not export/i,
  ]),

  // ── Folded skills (K5): using-snapshot-draft, using-piece-duplication, using-asset-folders ──
  // These skills were folded into tool descriptions and the manual ("Drafts, copies and asset folders"). Each rule below
  // may live in the manual source, the core instructions, or a tool's own description — anywhere an agent reads it
  // before acting. The check fails here, naming the rule, if the rule is dropped.
  inv("snapshot/draft: ask the user before committing a draft — commit is the user's gesture, never automatic", "using-snapshot-draft", [
    /(don'?t|never|do not)[\s\S]{0,40}commit[\s\S]{0,120}(ask|confirm)|snapshot`? action `?commit`?[\s\S]{0,200}(ask|confirm)s?(ing)? (with )?(the )?user( first| before)?|ask (the user )?(first )?before (calling |committing)[`\s]*(libi\.snapshot)?/i,
  ], [], { alsoIn: ["manual", "core", "tools"] }),
  inv("snapshot/draft: discarding a draft (or restoring a snapshot) needs the user's explicit confirmation", "using-snapshot-draft", [
    /(don'?t|never|do not)[\s\S]{0,12}discard[\s\S]{0,60}(without|unless)[\s\S]{0,30}(explicit )?(user )?confirmation|discard[\s\S]{0,200}(explicit user confirmation|user'?s explicit (confirmation|yes)|only (with|after) the user'?s? (explicit )?(confirmation|yes|ok))/i,
  ], [], { alsoIn: ["manual", "core", "tools"] }),
  inv("snapshot/draft: undo and go-back use the snapshot tools, never a regeneration from scratch", "using-snapshot-draft", [
    /(don'?t|never|do not)[\s\S]{0,20}regenerate[\s\S]{0,40}(from )?scratch|libi\.snapshot[\s\S]{0,160}(go back|undo|revert)|(go back|undo|revert)[\s\S]{0,160}libi\.snapshot/i,
  ], [], { alsoIn: ["manual", "core", "tools"] }),
  inv("duplication: a copy is independent and runs as a background job — poll the jobId before editing it", "using-piece-duplication", [
    /duplicate_piece[\s\S]{0,260}independent/i,
    /duplicate_(piece|folder)[\s\S]{0,260}jobId[\s\S]{0,200}(poll|libi\.job)/i,
  ], [], { alsoIn: ["manual", "core", "tools"] }),
  inv("duplication: the disk cost of a large-media piece is mentioned before copying it", "using-piece-duplication", [
    /(mention|tell|warn)[\s\S]{0,40}disk (cost|space)|disk (cost|space)[\s\S]{0,60}(first|before)/i,
  ], [], { alsoIn: ["manual", "core", "tools"] }),
  inv("asset folders: deleting a folder with cascade needs the user's explicit intent; orphan is the default", "using-asset-folders", [
    // Anchored to the folder's `mode: "cascade"`: the character catalog's `deleteAssets` also says "explicit user confirmation".
    /only\s+`?cascade`?\s+(on|with|when)[\s\S]{0,30}explicit|mode:?\s*[`'"]*cascade[`'"]*[\s\S]{0,240}(explicit user|the user'?s explicit)/i,
    /orphan[\s\S]{0,60}(default|safe)|default[\s\S]{0,30}orphan/i,
  ], [], { alsoIn: ["manual", "core", "tools"] }),
  inv("asset folders: one asset is one file; related assets go in a folder; there is no default or active file", "using-asset-folders", [
    /one asset\s*(=|is|per)\s*(one )?file/i,
    /group(ing)? (related )?(assets|files)[\s\S]{0,60}folder|folder[\s\S]{0,60}related (assets|files)/i,
    /no\s+["“`]?(default|active)(\s*\/\s*active)?["“`]?\s+file|there is no ["“`]?default/i,
  ], [], { alsoIn: ["manual", "core", "tools"] }),

  // ── Onboarding: the first minute a new user sees ──────────────────────────────────────────
  inv("onboarding: one build call against the pre-made film; honest that it is pre-made, editable, built in libi; tracking shot is a pre-made animation of real tracking", "onboarding-libi-explainer-short", [
    /libi\.build_onboarding_piece\(\{\}\)/,
    /libi\.show\(\{ target: "piece"/,
    /15\s*MB/i,
    /pre-?made/i,
    /editable/i,
    /built in libi/i,
    /pre-?made\s+animation/i,
    /real\s+object\s+tracking/i,
    /their\s+own\s+footage/i,
    /credits/i,
    /what (they|you) want to make/i,
    /could not|fail/i,
    /(do not|never)[\s\S]{0,20}(re-?try|call it again)/i,
    /\bnot\b[\s\S]{0,12}call any generation tool|never[\s\S]{0,12}call any generation tool|no provider, no libi generation tool/i,
  ], [
    /samplelib\.com/,
    /download\.blender\.org/,
    /Big Buck Bunny/,
    /libi\.add_overlay/,
    /libi\.apply_layer_effect/,
    /libi\.import_remote_files/,
    /66\s*MB/i,
    /settings\s*(→|->|>)?\s*tracking/i,
    /enable (object )?tracking in settings/i,
    /nothing is wrong with (their|your) install/i,
    /it is a (download|network) problem/i,
    /retry\s+(?:it\s+|the\s+\w+\s+)?(?:more than|up to|at most|twice|once more|a few|two|three)\b/i,
    /\b20 overlays\b/,
    /\b15 audio clips\b/,
    /\b6 scenes\b/,
    /suggest_provider/,
    /list_providers/,
    /references\/providers\//,
    /## Provider gate/,
    // The first minute a new user sees names no vendor: it spends nothing and needs no provider.
    /\b(elevenlabs|fal-ai|higgsfield|ace-step|kokoro|seedance|veo|kling)\b/i,
  ]),
];

/**
 * Skills that must reference another skill by name (or the skill it was merged into). Cheap, and it
 * is what keeps an orchestrator from losing the specialist it hands off to.
 */
const SKILL_REFERENCES: Readonly<Record<string, readonly string[]>> = {
  "mimic-video": ["ugc-product-video", "music-video-creation", "generic-video", "video-analysis", "video-planning", VOICE],
  "generic-video": ["video-planning", GEN, VOICE, ENGINES],
  "ugc-product-video": ["video-planning", VOICE, ENGINES],
  "stitching-multi-clip": [VOICE, "ugc-product-video"],
  "music-video-creation": ["video-planning", "music-creation", "audio-analysis"],
  "using-storyboard": ["video-planning"],
  "video-analysis": ["mimic-video"],
  "mimic-video-captions": ["three-overlays", "animated-text-overlays", "speech-captions"],
  "three-overlays": ["animated-text-overlays", "speech-captions"],
  [GEN]: [IMAGES, PHYSICAL, VOICE],
  "social-posting": ["social-music"],
  "music-creation": ["social-music"],
  templates: ["social-music"],
  [VOICE]: ["voice-replacement"],
};

/**
 * Skills that GENERATE — the entry points an agent opens to make something with a provider. Each must say, in its
 * own SKILL.md, that with no provider for the kind the agent calls libi.suggest_provider and stops (K2: one line).
 * Reference-only skills are NOT here and must not carry a gate (REFERENCE_ONLY below): the entry point that loads
 * them has already gated, and a gate in a reference is a second, drifting copy. Skills that generate nothing, or
 * whose first flow is free — video-analysis, stitching, onboarding — are deliberately absent too.
 */
const GENERATING: ReadonlyArray<readonly [skill: string, kind: string]> = [
  [GEN, "image"],
  ["generic-video", "video"],
  ["ugc-product-video", "video"],
  ["using-storyboard", "video"],
  ["removing-and-replacing-backgrounds", "video"],
  ["voice-replacement", "voice"],
  ["audio-analysis", "transcription"],
  ["music-creation", "music"],
  ["music-video-creation", "music"],
];

/**
 * Reference-only skills: loaded by an entry point that already gated, calling no generation tool of their own.
 * They carry no provider-gate block.
 */
const REFERENCE_ONLY: readonly string[] = ["stitching-multi-clip", "video-generation-craft"];
const GATE_BLOCK_MARKERS: readonly RegExp[] = [
  /## Provider gate/,
  /no remote provider tool and no libi extension for/i,
  /libi's own extension tools count as a provider/i,
];

/** Skills that build visuals. The "render and look before you say done" rule must reach each one. */
const BUILDS_VISUALS: readonly string[] = [
  "animating-overlays",
  "animated-text-overlays",
  "generic-video",
  "using-storyboard",
];

/** The mandate's required timing: before the agent reports the work finished. */
const RENDER_TIMING = /before you (tell|say|report)[\s\S]{0,40}(done|finished|complete)/i;

/**
 * "Render and look" as ONE block: the tool, the cheap contact sheet, the silent-font check and the timing must sit
 * within a screenful of each other. Tokens scattered across an 87 KB manual do not make a mandate.
 */
function renderAndLookBlockProblems(text: string): string[] {
  const WINDOW = 700;
  const at = [...text.matchAll(/render_overlay_frames/g)].map((m) => m.index!);
  if (at.length === 0) return ["render_overlay_frames is never named"];
  for (const i of at) {
    const block = text.slice(Math.max(0, i - WINDOW), i + WINDOW);
    if (/contactSheet/.test(block) && /unresolvedFonts/.test(block) && RENDER_TIMING.test(block)) return [];
  }
  return [`no block within ${WINDOW} chars of render_overlay_frames carries contactSheet, unresolvedFonts and the "before you tell the user it is done" timing`];
}

/**
 * The provider gate, stated once where every agent already is — core instructions or the manual.
 * Each pattern is anchored to the rule so that an unrelated sentence cannot satisfy it.
 */
const GATE_IN_CORE_OR_MANUAL: readonly RegExp[] = [
  /call\s+\*{0,2}`?libi\.suggest_provider[\s\S]{0,200}\bstop\b/i,
  /never ask for[\s\S]{0,40}(API )?key|never ask the user to paste a key|never handle a provider API key/i,
  /libi extension counts as a provider/i,
];

/**
 * The routing on `suggest_provider`'s `status: "none"` answer (everything libi knows of for the kind is already
 * connected, so there is nothing to offer — do not open anything, do not ask for a key). Without it an agent
 * improvises an exit. It is written once, in the core instructions or the manual, not in each generating skill.
 */
const STATUS_NONE_ROUTING: readonly RegExp[] = [
  /status:\s*"none"[\s\S]{0,200}nothing to connect/i,
  /do not open anything or ask for a key/i,
];

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Checks
// ─────────────────────────────────────────────────────────────────────────────────────────────

describe("skill invariants — each rule is stated somewhere in the owning skill's graph", () => {
  it("the table is not vacuous: every owner resolves to a live skill (or was folded into the manual and tools)", () => {
    const orphans: string[] = [];
    for (const i of INVARIANTS) {
      for (const owner of i.in) {
        if (resolveSkill(owner).length > 0) continue;
        // A folded skill has no folder left: its rule must say where it went.
        if (isFolded(owner) && i.alsoIn?.length) continue;
        orphans.push(`${i.name} → ${owner}`);
      }
    }
    expect(orphans, `owners that resolve to no skill (add a SKILL_SUCCESSORS entry):\n${orphans.join("\n")}`).toEqual([]);
    expect(INVARIANTS.length).toBeGreaterThan(50);
  });

  it.each(INVARIANTS.map((i) => [i.name, i] as const))("%s", async (_name, i) => {
    const slices = await slicesFor(i);
    expect(slices.length, "nothing to match against").toBeGreaterThan(0);
    const failures: string[] = [];
    for (const { label, text } of slices) {
      if (text.length === 0 && !i.alsoIn?.length) failures.push(`${label}: no text (skill or file missing)`);
      for (const re of i.has) if (!re.test(text)) failures.push(`${label}: not stated: ${re}`);
      for (const re of i.lacks ?? []) if (re.test(text)) failures.push(`${label}: must not appear: ${re}`);
      for (const problem of i.check?.(text) ?? []) failures.push(`${label}: ${problem}`);
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

describe("skill hand-offs — an orchestrator names the specialist it hands off to", () => {
  it.each(Object.entries(SKILL_REFERENCES))("%s", (from, targets) => {
    const own = resolveSkills([from]);
    expect(own.length, `${from} has no live skill`).toBeGreaterThan(0);
    // The whole folder, not just SKILL.md: a hand-off may move into a reference when the skill is slimmed.
    const text = own.map((s) => s.text).join("\n");
    const missing = targets.filter((to) => !mentionsSkill(text, to));
    expect(missing, `${from} no longer names: ${missing.join(", ")}`).toEqual([]);
  });
});

describe("the core instructions or the manual route recreation to mimic-video", () => {
  it("names mimic-video for recreate / mimic requests", () => {
    const text = `${coreText()}\n${manualText()}`;
    expect(mentionsSkill(text, "mimic-video")).toBe(true);
    expect(text).toMatch(/recreat|mimic/i);
  });
});

describe("provider gate — a generating skill says: no provider, call suggest_provider, stop", () => {
  it.each(GENERATING.map((g) => [g[0], g[1]] as const))("%s (%s)", (skill, kind) => {
    const body = bodyText([skill]);
    expect(body.length, `${skill} resolves to no skill`).toBeGreaterThan(0);
    expect(body, `${skill}: no mention of libi.suggest_provider`).toMatch(/libi\.suggest_provider/);
    expect(body, `${skill}: never says to stop`).toMatch(/\bstop\b/i);
    expect(body, `${skill}: never names the kind "${kind}"`).toMatch(new RegExp(`\\b${kind}\\b`, "i"));
  });

  it("the core instructions or the manual carry the full gate", () => {
    const text = collapse(`${coreText()}\n${manualText()}`);
    const missing = GATE_IN_CORE_OR_MANUAL.filter((re) => !re.test(text)).map(String);
    expect(missing, `the core + manual no longer state the gate:\n${missing.join("\n")}`).toEqual([]);
  });

  it("the core instructions state the stop-and-suggest rule themselves", () => {
    const core = collapse(coreText());
    expect(core).toMatch(GATE_IN_CORE_OR_MANUAL[0]);
    expect(core).toMatch(GATE_IN_CORE_OR_MANUAL[1]);
  });

  it('`status: "none"` routing (nothing to connect; open nothing, ask for no key) is stated in the core or the manual', () => {
    const text = collapse(`${coreText()}\n${manualText()}`);
    const missing = STATUS_NONE_ROUTING.filter((re) => !re.test(text)).map(String);
    expect(missing, `no one tells the agent what to do on status "none":\n${missing.join("\n")}`).toEqual([]);
  });

  it("no skill inlines the multi-step gate: the rule is written once, in the manual", () => {
    const offenders = skillIds().filter((id) => GATE_BLOCK_MARKERS.some((re) => re.test(graphText([id]))));
    expect(offenders, `the full gate lives in the manual's Providers section; a skill carries one line:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("the table lists real skills only (no typo hides a gate)", () => {
    const live = new Set(skillIds());
    for (const [skill] of GENERATING) {
      expect(resolveSkill(skill).length > 0 || live.has(skill), `${skill} resolves to nothing`).toBe(true);
    }
  });

  it.each(REFERENCE_ONLY)("reference-only %s carries no provider gate", (skill) => {
    if (!skillIds().includes(skill)) return; // merged away, or not created yet
    const text = graphText([skill]);
    const grown = GATE_BLOCK_MARKERS.filter((re) => re.test(text)).map(String);
    expect(grown, `${skill} grew a provider gate; the entry point that loads it has already gated:\n${grown.join("\n")}`).toEqual([]);
  });

  it("the voice authority names no `voice` provider kind: a voice provider is not a substitute for a video one", () => {
    const text = graphText(["video-generation-craft"]);
    expect(text.length, "video-generation-craft resolves to no skill").toBeGreaterThan(0);
    expect(text).not.toMatch(/suggest_provider\(\{ kind: "voice"/);
  });
});

describe("paid generation — the core instructions state it too (each skill states it itself, above)", () => {
  it("say what you will generate and roughly what it costs, and get a yes first", () => {
    expect(collapse(coreText())).toMatch(/paid generation costs money[\s\S]{0,160}(get a yes|yes first|approval|confirm)/i);
  });
});

describe("render and look — the rule is stated centrally as one block, or in every skill that builds visuals", () => {
  const central = collapse(`${coreText()}\n${manualText()}`);
  const centrally = renderAndLookBlockProblems(central).length === 0 && RENDER_TIMING.test(central);

  it.each(BUILDS_VISUALS)("%s", (skill) => {
    if (centrally) return; // stated once in the core/manual as a single mandate: that is the rule's single owner
    const text = graphText([skill]);
    expect(text.length, `${skill} resolves to no skill`).toBeGreaterThan(0);
    const problems = renderAndLookBlockProblems(text);
    expect(
      problems,
      `${skill} neither states render-and-look itself nor can lean on the core/manual stating it:\n${problems.join("\n")}`,
    ).toEqual([]);
  });

  it("the block check bites: a mandate whose parts are scattered, or that lacks its timing, does not count", () => {
    const whole = "before you tell the user it is done — libi.render_overlay_frames({ contactSheet: true }); check unresolvedFonts";
    expect(renderAndLookBlockProblems(whole)).toEqual([]);
    expect(renderAndLookBlockProblems(whole.replace("before you tell the user it is done", "when you feel like it"))).not.toEqual([]);
    expect(renderAndLookBlockProblems(whole.replace("unresolvedFonts", "nothing"))).not.toEqual([]);
    const scattered = `${whole.split("—")[0]} ${"x ".repeat(800)} libi.render_overlay_frames contactSheet unresolvedFonts`;
    expect(renderAndLookBlockProblems(scattered)).not.toEqual([]);
  });
});
