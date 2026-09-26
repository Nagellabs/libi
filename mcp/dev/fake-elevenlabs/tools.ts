/**
 * The fake ElevenLabs' tools: a zero-cost mirror of the creative tools libi's
 * skills use on ElevenLabs' hosted MCP. Everything is a FLOW run, as there:
 * a generate call starts a session and returns ids, not audio; a status poll
 * answers `poll_after_seconds` until the session finishes, then hands back the
 * audio in `media[]` (URLs served by the studio's test-mode route) or the text
 * in `transcripts[]`.
 *
 * Kept faithful where an agent's mistake would cost a user money or break the
 * import: `generations_count` defaults to 4, `context` is required, a voice must
 * come from `creative_list_voices`, the first poll is still running, an upload's
 * bytes must land at its URL with the declared Content-Type before it is
 * finalized, and connected nodes must be on the flow named.
 *
 * Result shapes are the live server's, captured 2026-09-25 from real calls
 * (docs-local/qa/2026-09-25-fu-B4-live-shapes.md): the start result, the
 * `estimate_only` result (which creates a flow and node, as the real one does),
 * the completed status poll for speech and for transcription, the voice list,
 * and the upload / finalize results. Not captured, and so this fake's own: the
 * still-running poll (every real run had finished by its first poll), how a
 * multi-take run splits into sessions (modelled as ONE session per node with
 * `generations_count` generations, as the real `summary.generations_by_node`
 * suggests), and the node-type / model-schema answers.
 *
 * What the real transcription result does NOT carry, and so neither does this:
 * per-word timing, speaker labels, audio events. `transcripts[].text` is flat
 * text, and its `download_url` serves the same text as a .txt.
 */
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { z } from "zod/v3";
import {
  elevenlabsTestUploadDir,
  uploadBytesPath,
  uploadExpectationPath,
  type UploadExpectation,
} from "@/lib/providers/elevenlabs-test-media";
import { recordCall, type ElevenLabsCall } from "./recorder";
import { writeAudioPlaceholder } from "./placeholders";
import { outputUrl, resolveOutputDir, uploadUrl } from "./output";
import {
  NODE_MODELS,
  type CreateAssetUploadSchema,
  type CreateFlowSchema,
  type FinalizeAssetUploadSchema,
  type FlowNodeTypesSchema,
  type FlowRunStatusSchema,
  type GenerateInFlowSchema,
  type GenerateSpeechSchema,
  type ListVoicesSchema,
  type ModelSchemaSchema,
  type TranscribeAudioSchema,
} from "./schemas";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: true };

/** The hosted default: every generate call makes FOUR takes, and charges for each, unless told otherwise. */
export const DEFAULT_GENERATIONS_COUNT = 4;
/** What a start result and a still-running poll ask the agent to wait (the live server said 3). */
export const POLL_AFTER_SECONDS = 3;
/** The live server's rate: 18 credits priced at 0.36 cents. */
const CENTS_PER_CREDIT = 0.02;
/** The live `creative_create_asset_upload`'s `max_file_size_bytes` (200 MiB). */
export const MAX_UPLOAD_BYTES = 209_715_200;

const NOT_FINISHED_NOTES =
  "Not finished yet. Wait poll_after_seconds, then call creative_get_flow_run_status with this flow_id and session_ids. Repeat until all_completed or has_failures is true.";
const ESTIMATE_NOTES = "Estimate only — nothing was generated and nothing was charged. Call again without estimate_only to run it.";

export const PLACEHOLDER_TRANSCRIPT = "[fake-elevenlabs] This is a placeholder transcript generated in test mode.";

/** A voice as the live `creative_list_voices` returns it: the descriptors sit under `labels`, and the name carries a tagline. */
export interface FakeVoice {
  voice_id: string;
  name: string;
  category: "premade";
  description: string;
  labels: {
    use_case: string;
    accent: string;
    gender: "male" | "female" | "neutral";
    age: "young" | "middle_aged" | "old";
    descriptive: string;
    language: string;
  };
  preview_url: string;
  is_library_voice: false;
  orb_url: string;
}

/** Obviously fake media URLs: nothing an agent needs is behind them. */
const fakeVoiceMedia = (voiceId: string) => ({
  preview_url: `https://fake-elevenlabs.invalid/voices/${voiceId}/preview.mp3`,
  is_library_voice: false as const,
  orb_url: `https://fake-elevenlabs.invalid/voices/${voiceId}/orb.png`,
});

export const FAKE_VOICES: readonly FakeVoice[] = [
  { voice_id: "fakevoiceRachel0001", name: "Rachel - Calm, Warm, Clear", category: "premade", description: "Warm, clear narration.",
    labels: { use_case: "narrative_story", accent: "american", gender: "female", age: "young", descriptive: "calm", language: "en" }, ...fakeVoiceMedia("fakevoiceRachel0001") },
  { voice_id: "fakevoiceAdam000002", name: "Adam - Deep, Confident, Announcer", category: "premade", description: "Deep, confident announcer.",
    labels: { use_case: "advertisement", accent: "american", gender: "male", age: "middle_aged", descriptive: "deep", language: "en" }, ...fakeVoiceMedia("fakevoiceAdam000002") },
  { voice_id: "fakevoiceMia0000003", name: "Mia - Upbeat, Casual, Bright", category: "premade", description: "Bright, casual creator voice.",
    labels: { use_case: "social_media", accent: "british", gender: "female", age: "young", descriptive: "upbeat", language: "en" }, ...fakeVoiceMedia("fakevoiceMia0000003") },
  { voice_id: "fakevoiceJonas00004", name: "Jonas - Relaxed, Casual", category: "premade", description: "Relaxed German speaker.",
    labels: { use_case: "conversational", accent: "german", gender: "male", age: "young", descriptive: "relaxed", language: "de" }, ...fakeVoiceMedia("fakevoiceJonas00004") },
  { voice_id: "fakevoiceSol0000005", name: "Sol - Gentle, Soft", category: "premade", description: "Gentle Spanish narration.",
    labels: { use_case: "informative_educational", accent: "neutral", gender: "neutral", age: "middle_aged", descriptive: "gentle", language: "es" }, ...fakeVoiceMedia("fakevoiceSol0000005") },
];

interface FlowNode {
  id: string;
  nodeType: string;
  modelId?: string;
  /** An uploaded file placed on the flow, or a generation node. */
  kind: "asset" | "generation";
  /** An asset node's bytes, and the served copy a transcript's `source.url` points at. */
  sizeBytes?: number;
  servedFile?: string;
}

interface Flow {
  id: string;
  name?: string;
  nodes: Map<string, FlowNode>;
}

interface Generation {
  id: string;
  modelId: string;
  modality: "audio" | "text";
  prompt?: string;
  createdAtMs: number;
  credits: number;
  /** Audio: the placeholder file and its length. */
  outputFile?: string;
  durationSeconds?: number;
  voice?: FakeVoice;
  /** Text: the transcript, its served .txt, and the audio it was read from. */
  transcript?: string;
  transcriptFile?: string;
  sourceFile?: string;
}

interface Session {
  id: string;
  flowId: string;
  nodeId: string;
  nodeType: string;
  polls: number;
  generations: Generation[];
}

const flows = new Map<string, Flow>();
const sessions = new Map<string, Session>();

/** Tests only. */
export function __resetFakeElevenLabsState(): void {
  flows.clear();
  sessions.clear();
}

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const round = (n: number, places: number) => Number(n.toFixed(places));

function refuse(call: ElevenLabsCall, message: string): ToolResult {
  recordCall({ ...call, rejected: true, error: message });
  return { content: [{ type: "text", text: message }], isError: true };
}

function canvasUrl(flowId: string): string {
  return `https://elevenlabs.io/app/flows/${flowId}`;
}

function newFlow(name?: string): Flow {
  const flow: Flow = { id: `flow_fake_${hex(8)}`, name, nodes: new Map() };
  flows.set(flow.id, flow);
  return flow;
}

/** The flow a run lands on: the one named, or a new one (as the real server creates one when `flow_id` is omitted). */
function resolveFlow(flowId: string | undefined): { flow: Flow; created: boolean } | { error: string } {
  if (!flowId) return { flow: newFlow(), created: true };
  const found = flows.get(flowId);
  return found ? { flow: found, created: false } : { error: `Flow "${flowId}" was not found.` };
}

/**
 * Credits ONE generation costs, near the live server's: speech is a credit a character (half on the
 * flash / turbo models), and a transcription is FRACTIONAL, scaled from the audio's size (the live run
 * charged 7.918 credits for a 41 KB, 1.4 s mp3). The rest are this fake's round numbers.
 */
function creditsPerGeneration(nodeType: string, modelId: string, prompt: string, inputBytes?: number): number {
  switch (nodeType) {
    case "tts":
      return Math.max(1, Math.ceil(prompt.length * (modelId === "eleven_flash_v2_5" || modelId === "eleven_turbo_v2_5" ? 0.5 : 1)));
    case "speech-to-text":
      return inputBytes ? Math.max(0.001, round(inputBytes * 0.0001925, 3)) : 7.918;
    case "sfx":
      return 100;
    case "music":
    case "video-to-music":
      return 800;
    case "voice-changer":
      return 300;
    case "voice-isolator":
      return 200;
    default:
      return 100;
  }
}

function estimatedRuntimeSeconds(nodeType: string): number {
  return nodeType === "music" || nodeType === "video-to-music" ? 30 : nodeType === "tts" || nodeType === "speech-to-text" ? 3 : 5;
}

function placeholderSeconds(nodeType: string, prompt: string): number {
  switch (nodeType) {
    case "tts":
      return Math.min(30, Math.max(1, Math.round(prompt.length / 15)));
    case "sfx":
      return 2;
    case "music":
    case "video-to-music":
      return 10;
    default:
      return 3;
  }
}

/** The bytes of the asset nodes a run reads, for pricing a transcription. */
function inputBytes(flow: Flow, connectFrom: string[] | undefined): number | undefined {
  const sizes = (connectFrom ?? []).map((id) => flow.nodes.get(id)?.sizeBytes).filter((n): n is number => typeof n === "number");
  return sizes.length ? sizes.reduce((a, b) => a + b, 0) : undefined;
}

interface RunOpts {
  call: ElevenLabsCall;
  nodeType: string;
  modelId: string;
  prompt: string;
  flowId?: string;
  connectFrom?: string[];
  voiceId?: string;
  count: number;
  /** `creative_generate_speech`'s results name their view; the other tools' did not. */
  viewKind?: string;
}

/** Place the node on its flow, or refuse: the named flow must exist and hold every `connect_from` node. */
function placeNode(opts: RunOpts): { flow: Flow; created: boolean; node: FlowNode } | ToolResult {
  const resolved = resolveFlow(opts.flowId);
  if ("error" in resolved) return refuse(opts.call, resolved.error);
  const { flow, created } = resolved;
  for (const id of opts.connectFrom ?? []) {
    if (!flow.nodes.has(id)) {
      return refuse(opts.call, `connect_from node "${id}" is not on flow "${flow.id}". Pass the flow_id that holds it.`);
    }
  }
  const node: FlowNode = { id: `node_fake_${hex(6)}`, nodeType: opts.nodeType, modelId: opts.modelId, kind: "generation" };
  flow.nodes.set(node.id, node);
  return { flow, created, node };
}

/** `estimate_only`: the price, and — as on the real server — a flow and node created along the way. Nothing runs. */
function estimate(opts: RunOpts): ToolResult {
  const placed = placeNode(opts);
  if (!("flow" in placed)) return placed;
  const { flow, created, node } = placed;
  const credits = round(creditsPerGeneration(opts.nodeType, opts.modelId, opts.prompt, inputBytes(flow, opts.connectFrom)) * opts.count, 3);
  recordCall({ ...opts.call, flow_id: flow.id, node_id: node.id });
  return json({
    flow_id: flow.id,
    flow_created: created,
    node_id: node.id,
    url: canvasUrl(flow.id),
    estimate: {
      credits,
      price_cents: round(credits * CENTS_PER_CREDIT, 4),
      generations_count: opts.count,
      currency: "usd",
      estimated_runtime_seconds: estimatedRuntimeSeconds(opts.nodeType),
    },
    notes: ESTIMATE_NOTES,
  });
}

/** One run: the node, ONE session, and each generation's placeholder audio or transcript. */
async function startRun(opts: RunOpts): Promise<ToolResult> {
  const placed = placeNode(opts);
  if (!("flow" in placed)) return placed;
  const { flow, created, node } = placed;
  const { nodeType, modelId, prompt, count } = opts;
  const perGeneration = creditsPerGeneration(nodeType, modelId, prompt, inputBytes(flow, opts.connectFrom));
  const voice = opts.voiceId ? FAKE_VOICES.find((v) => v.voice_id === opts.voiceId) : undefined;
  const source = (opts.connectFrom ?? []).map((id) => flow.nodes.get(id)?.servedFile).find(Boolean);
  const session: Session = { id: `sess_fake_${hex(8)}`, flowId: flow.id, nodeId: node.id, nodeType, polls: 0, generations: [] };
  for (let i = 0; i < count; i++) {
    const gen: Generation = {
      id: `gen_fake_${hex(8)}`,
      modelId,
      modality: nodeType === "speech-to-text" ? "text" : "audio",
      createdAtMs: Date.now(),
      credits: perGeneration,
    };
    if (gen.modality === "text") {
      gen.transcript = PLACEHOLDER_TRANSCRIPT;
      gen.transcriptFile = `el_stt_${gen.id}.txt`;
      gen.sourceFile = source;
      writeFileSync(join(resolveOutputDir(), gen.transcriptFile), gen.transcript);
    } else {
      gen.prompt = prompt;
      gen.voice = voice;
      gen.durationSeconds = placeholderSeconds(nodeType, prompt);
      gen.outputFile = basename(
        await writeAudioPlaceholder({ stem: `el_${nodeType.replace(/-/g, "")}_${gen.id}`, durationSeconds: gen.durationSeconds, frequency: 330 + 110 * i }),
      );
    }
    session.generations.push(gen);
  }
  sessions.set(session.id, session);
  recordCall({ ...opts.call, flow_id: flow.id, node_id: node.id, session_ids: [session.id] });
  const viewStateId = `viewstate_fake_${hex(8)}`;
  return json({
    flow_id: flow.id,
    flow_created: created,
    node_id: node.id,
    url: `${canvasUrl(flow.id)}?vs=${viewStateId}`,
    results: [{ success: true, node_id: node.id, session_id: session.id }],
    summary: { nodes_run: 1, generations_started: count, failed: 0, generations_by_node: { [node.id]: count } },
    session_ids: [session.id],
    poll_after_seconds: POLL_AFTER_SECONDS,
    notes: NOT_FINISHED_NOTES,
    ...(opts.viewKind ? { view_kind: opts.viewKind } : {}),
    view_state_id: viewStateId,
    flow_url: canvasUrl(flow.id),
  });
}

export function creative_list_voices(args: z.infer<typeof ListVoicesSchema>): ToolResult {
  const search = args.search?.toLowerCase();
  const voices = FAKE_VOICES.filter(
    (v) =>
      (!search || `${v.name} ${v.description} ${v.labels.descriptive}`.toLowerCase().includes(search)) &&
      (!args.gender || v.labels.gender === args.gender) &&
      (!args.age || v.labels.age === args.age) &&
      (!args.languages?.length || args.languages.includes(v.labels.language)) &&
      (!args.accent || v.labels.accent === args.accent.toLowerCase()) &&
      (!args.use_cases?.length || args.use_cases.includes(v.labels.use_case)) &&
      (!args.descriptives?.length || args.descriptives.includes(v.labels.descriptive)),
  );
  recordCall({ tool: "creative_list_voices", input: args });
  // The live list pages at 25; this one never has more.
  return json({ voices, total_count: voices.length, has_more: false, library_total: -1 });
}

export function creative_create_flow(args: z.infer<typeof CreateFlowSchema>): ToolResult {
  const flow = newFlow(args.name);
  recordCall({ tool: "creative_create_flow", input: args, flow_id: flow.id });
  return json({ flow_id: flow.id, name: args.name ?? null, url: canvasUrl(flow.id) });
}

export async function creative_generate_speech(args: z.infer<typeof GenerateSpeechSchema>): Promise<ToolResult> {
  const count = args.generations_count ?? DEFAULT_GENERATIONS_COUNT;
  const call: ElevenLabsCall = {
    tool: "creative_generate_speech", input: args, voice_id: args.voice_id, model_id: args.model_id, node_type: "tts",
    generations_count: count, estimate_only: args.estimate_only === true, prompt: args.prompt,
  };
  if (!args.prompt.trim()) return refuse(call, "prompt (the text to speak) is required.");
  if (!FAKE_VOICES.some((v) => v.voice_id === args.voice_id)) {
    return refuse(call, `Voice "${args.voice_id}" was not found. Use creative_list_voices to find a voice_id.`);
  }
  const opts: RunOpts = {
    call, nodeType: "tts", modelId: args.model_id, prompt: args.prompt, flowId: args.flow_id, voiceId: args.voice_id, count,
    viewKind: "speech_generation",
  };
  return args.estimate_only ? estimate(opts) : startRun(opts);
}

/** Node types whose runs read an upstream audio node, and so need `connect_from`. */
const NEEDS_INPUT = new Set(["speech-to-text", "voice-changer", "voice-isolator", "video-to-music"]);
/** Node types that speak with a voice. */
const NEEDS_VOICE = new Set(["tts", "voice-changer"]);

export async function creative_generate_in_flow(args: z.infer<typeof GenerateInFlowSchema>): Promise<ToolResult> {
  const count = args.generations_count ?? DEFAULT_GENERATIONS_COUNT;
  const call: ElevenLabsCall = {
    tool: "creative_generate_in_flow", input: args, voice_id: args.voice_id, model_id: args.model_id, node_type: args.node_type,
    generations_count: count, estimate_only: args.estimate_only === true, prompt: args.prompt,
  };
  const models = NODE_MODELS[args.node_type];
  if (!models) {
    return refuse(call, `libi's test-mode ElevenLabs does not mirror "${args.node_type}" nodes; it mirrors ${Object.keys(NODE_MODELS).join(", ")}.`);
  }
  if (!models.includes(args.model_id)) {
    return refuse(call, `Model "${args.model_id}" is not available for "${args.node_type}" nodes. Available: ${models.join(", ")}.`);
  }
  if (NEEDS_VOICE.has(args.node_type)) {
    if (!args.voice_id) return refuse(call, `voice_id is required for "${args.node_type}" nodes. Use creative_list_voices to find one.`);
    if (!FAKE_VOICES.some((v) => v.voice_id === args.voice_id)) {
      return refuse(call, `Voice "${args.voice_id}" was not found. Use creative_list_voices to find a voice_id.`);
    }
  }
  if (NEEDS_INPUT.has(args.node_type) && !args.connect_from?.length) {
    return refuse(call, `connect_from is required for "${args.node_type}" nodes: wire the audio node it reads (creative_finalize_asset_upload with a flow_id places an uploaded file on the flow).`);
  }
  const opts: RunOpts = {
    call, nodeType: args.node_type, modelId: args.model_id, prompt: args.prompt,
    flowId: args.flow_id, connectFrom: args.connect_from, voiceId: args.voice_id, count,
  };
  return args.estimate_only ? estimate(opts) : startRun(opts);
}

export async function creative_transcribe_audio(args: z.infer<typeof TranscribeAudioSchema>): Promise<ToolResult> {
  const call: ElevenLabsCall = {
    tool: "creative_transcribe_audio", input: args, model_id: args.model_id, node_type: "speech-to-text",
    generations_count: 1, estimate_only: args.estimate_only === true,
  };
  if (!args.connect_from?.length) {
    return refuse(call, "connect_from is required: the audio node on this flow to transcribe.");
  }
  const opts: RunOpts = {
    call, nodeType: "speech-to-text", modelId: args.model_id, prompt: "",
    flowId: args.flow_id, connectFrom: args.connect_from, count: 1,
  };
  return args.estimate_only ? estimate(opts) : startRun(opts);
}

const price = (credits: number) => ({ credits, price_cents: round(credits * CENTS_PER_CREDIT, 6), cost_fiat_currency: "usd" });

export function creative_get_flow_run_status(args: z.infer<typeof FlowRunStatusSchema>): ToolResult {
  const call: ElevenLabsCall = { tool: "creative_get_flow_run_status", input: args, flow_id: args.flow_id, session_ids: args.session_ids };
  if (!flows.has(args.flow_id)) return refuse(call, `Flow "${args.flow_id}" was not found.`);
  const found: Session[] = [];
  for (const id of args.session_ids) {
    const session = sessions.get(id);
    if (!session || session.flowId !== args.flow_id) return refuse(call, `Session "${id}" is not a run on flow "${args.flow_id}".`);
    found.push(session);
  }
  for (const session of found) session.polls++;
  const head = {
    flow_id: args.flow_id,
    flow_created: false,
    url: canvasUrl(args.flow_id),
    flow_url: canvasUrl(args.flow_id),
    // The live result names ONE session here, and every session in `session_ids`.
    session_id: found[0].id,
  };
  // A session's first poll finds it still running, as a real generation would be.
  if (found.some((s) => s.polls < 2)) {
    recordCall({ ...call });
    return json({
      ...head,
      generations: found.flatMap((s) =>
        s.generations.map((g) => ({
          id: g.id, status: s.polls < 2 ? "running" : "completed", model_id: g.modelId, modality: g.modality,
          ...(g.prompt !== undefined ? { prompt: g.prompt } : {}), created_at_unix_ms: g.createdAtMs,
        })),
      ),
      all_completed: false,
      has_failures: false,
      session_ids: args.session_ids,
      poll_after_seconds: POLL_AFTER_SECONDS,
      notes: NOT_FINISHED_NOTES,
    });
  }
  const gens = found.flatMap((s) => s.generations);
  const generations = gens.map((g) => ({
    id: g.id,
    status: "completed",
    model_id: g.modelId,
    modality: g.modality,
    ...(g.prompt !== undefined ? { prompt: g.prompt } : {}),
    ...(g.durationSeconds !== undefined ? { duration_secs: g.durationSeconds } : {}),
    created_at_unix_ms: g.createdAtMs,
    price: price(g.credits),
  }));
  // Audio lives in `media[]`, joined to its generation by `generation_id` — not on the generation itself.
  const media = gens
    .filter((g) => g.outputFile)
    .map((g) => {
      const url = outputUrl(g.outputFile ?? "");
      return {
        generation_id: g.id,
        kind: "audio",
        url,
        prompt: g.prompt,
        duration_secs: g.durationSeconds,
        master_url: url,
        model_id: g.modelId,
        ...(g.voice ? { voice: { voice_id: g.voice.voice_id, name: g.voice.name, orb_url: g.voice.orb_url } } : {}),
      };
    });
  // Text lives in `transcripts[]`: flat text only, no per-word timing, no speakers, no audio events.
  const transcripts = gens
    .filter((g) => g.transcript !== undefined)
    .map((g) => ({
      generation_id: g.id,
      text: g.transcript,
      model_id: g.modelId,
      download_url: outputUrl(g.transcriptFile ?? ""),
      language_code: "eng",
      language_probability: 0.98,
      spoken_duration_secs: 4.2,
      ...(g.sourceFile ? { source: { kind: "audio", url: outputUrl(g.sourceFile) } } : {}),
    }));
  recordCall({ ...call, output_urls: media.map((m) => m.url) });
  return json({
    ...head,
    generations,
    all_completed: true,
    has_failures: false,
    session_ids: args.session_ids,
    ...(media.length ? { media } : {}),
    ...(transcripts.length ? { transcripts } : {}),
  });
}

export function creative_get_flow_node_types(args: z.infer<typeof FlowNodeTypesSchema>): ToolResult {
  recordCall({ tool: "creative_get_flow_node_types", input: args });
  return json({
    node_types: Object.entries(NODE_MODELS).map(([nodeType, models]) => ({ node_type: nodeType, models, default_model: models[0] })),
  });
}

const MODEL_PARAMETERS: Record<string, Record<string, unknown>> = {
  tts: {
    stability: { type: "number", min: 0, max: 1, default: 0.5 },
    similarity_boost: { type: "number", min: 0, max: 1, default: 0.75 },
    style: { type: "number", min: 0, max: 1, default: 0 },
    speed: { type: "number", min: 0.7, max: 1.2, default: 1 },
  },
  sfx: { duration_seconds: { type: "number", min: 0.5, max: 30 }, prompt_influence: { type: "number", min: 0, max: 1, default: 0.3 } },
  music: { duration_seconds: { type: "number", min: 10, max: 300, default: 30 }, force_instrumental: { type: "boolean", default: false } },
  "video-to-music": { duration_seconds: { type: "number", min: 10, max: 300 } },
  // No diarization or timestamp switch: whatever the node runs, the hosted result is flat text.
  "speech-to-text": {},
  "voice-changer": { stability: { type: "number", min: 0, max: 1, default: 0.5 }, remove_background_noise: { type: "boolean", default: false } },
  "voice-isolator": {},
};

export function creative_get_model_schema(args: z.infer<typeof ModelSchemaSchema>): ToolResult {
  const call: ElevenLabsCall = { tool: "creative_get_model_schema", input: args, model_id: args.model_id, node_type: args.node_type };
  const models = NODE_MODELS[args.node_type];
  if (!models || !models.includes(args.model_id)) {
    return refuse(call, `Model "${args.model_id}" is not available for "${args.node_type}" nodes.`);
  }
  recordCall(call);
  return json({ node_type: args.node_type, model_id: args.model_id, parameters: MODEL_PARAMETERS[args.node_type] ?? {} });
}

export function creative_create_asset_upload(args: z.infer<typeof CreateAssetUploadSchema>): ToolResult {
  const call: ElevenLabsCall = { tool: "creative_create_asset_upload", input: args };
  if (args.file_size > MAX_UPLOAD_BYTES) {
    return refuse(call, `file_size ${args.file_size} is over the ${MAX_UPLOAD_BYTES}-byte limit.`);
  }
  const assetId = `asset_fake_${hex(8)}`;
  mkdirSync(elevenlabsTestUploadDir(), { recursive: true });
  const expectation: UploadExpectation = { mime_type: args.mime_type, file_size: args.file_size, name: args.name };
  writeFileSync(uploadExpectationPath(assetId), JSON.stringify(expectation));
  recordCall({ ...call, asset_id: assetId });
  // The live result is exactly these three: no method, no headers, no instructions.
  return json({ asset_id: assetId, upload_url: uploadUrl(assetId), max_file_size_bytes: MAX_UPLOAD_BYTES });
}

/** The extension the studio's test-mode route serves an uploaded audio file under, when it is one it can serve. */
function servedExtension(mimeType: string): "mp3" | "wav" | null {
  if (mimeType === "audio/mpeg" || mimeType === "audio/mp3") return "mp3";
  if (mimeType === "audio/wav" || mimeType === "audio/x-wav" || mimeType === "audio/wave") return "wav";
  return null;
}

export function creative_finalize_asset_upload(args: z.infer<typeof FinalizeAssetUploadSchema>): ToolResult {
  const call: ElevenLabsCall = { tool: "creative_finalize_asset_upload", input: args, asset_id: args.asset_id, flow_id: args.flow_id };
  let expected: UploadExpectation;
  try {
    expected = JSON.parse(readFileSync(uploadExpectationPath(args.asset_id), "utf8")) as UploadExpectation;
  } catch {
    return refuse(call, `Asset "${args.asset_id}" was not found. Start an upload with creative_create_asset_upload.`);
  }
  const bytes = uploadBytesPath(args.asset_id);
  if (!existsSync(bytes)) return refuse(call, "The upload has not landed: PUT the file's bytes to upload_url first.");
  const size = statSync(bytes).size;
  if (size !== expected.file_size) {
    return refuse(call, `The uploaded file is ${size} bytes, but the upload was started for ${expected.file_size}.`);
  }
  const asset = { asset_id: args.asset_id, name: expected.name, mime_type: expected.mime_type, size_bytes: size };
  if (!args.flow_id) {
    if (args.node_id) return refuse(call, "node_id needs the flow_id that holds it.");
    recordCall(call);
    return json(asset);
  }
  const flow = flows.get(args.flow_id);
  if (!flow) return refuse(call, `Flow "${args.flow_id}" was not found.`);
  if (args.node_id && !flow.nodes.has(args.node_id)) return refuse(call, `Node "${args.node_id}" is not on flow "${flow.id}".`);
  const modality = expected.mime_type.split("/")[0];
  const node: FlowNode = { id: args.node_id ?? `node_fake_${hex(6)}`, nodeType: `${modality}-asset`, kind: "asset", sizeBytes: size };
  // A transcript names the audio it read (`source.url`); serve a copy of the upload for that.
  const ext = servedExtension(expected.mime_type);
  if (ext) {
    node.servedFile = `${args.asset_id}_preview.${ext}`;
    copyFileSync(bytes, join(resolveOutputDir(), node.servedFile));
  }
  flow.nodes.set(node.id, node);
  recordCall({ ...call, node_id: node.id });
  return json({ ...asset, flow_id: flow.id, node_id: node.id });
}
