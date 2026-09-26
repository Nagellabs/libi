// The fake ElevenLabs mirrors the creative tools libi's skills use on ElevenLabs' HOSTED MCP (2026-09-25). What
// these cases pin is what an eval relies on: the hosted defaults that cost a user money (4 takes unless told
// otherwise), the run → poll → `media[].url` shape, the upload's PUT-then-finalize contract — and the result
// shapes the live server returned on 2026-09-25 (docs-local/qa/2026-09-25-fu-B4-live-shapes.md), so a skill that
// reads a field reality never returns fails here and not on a user's machine.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hasFfmpeg, FFMPEG_SKIP_REASON } from "@/__tests__/helpers/media";

// The audio-producing runs write a REAL sine-wave MP3 via ffmpeg. Skip only those cases when ffmpeg is absent;
// validation, estimates and uploads never spawn it and always run.
if (!hasFfmpeg()) console.info(`[skip] ${FFMPEG_SKIP_REASON}`);
const itWithFfmpeg = it.skipIf(!hasFfmpeg());

async function load() {
  const tools = await import("@/mcp/dev/fake-elevenlabs/tools");
  tools.__resetFakeElevenLabsState();
  return tools;
}
async function media() {
  return import("@/lib/providers/elevenlabs-test-media");
}
function readCalls(home: string) {
  const p = join(home, "test-mode", "elevenlabs-calls.jsonl");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
const body = (res: { content: { text: string }[] }) => JSON.parse(res.content[0].text);
const context = "libi test";
const VOICE = "fakevoiceRachel0001";

describe("fake-elevenlabs — hosted creative tools", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "libi-el-tools-"));
    process.env.LIBI_HOME = home;
    process.env.LIBI_SERVER_PORT = "3999";
  });
  afterEach(() => {
    delete process.env.LIBI_HOME;
    delete process.env.LIBI_SERVER_PORT;
    rmSync(home, { recursive: true, force: true });
  });

  it("creative_list_voices answers in the live shape (descriptors under labels, total_count, has_more), filters, and records the call", async () => {
    const t = await load();
    const all = body(t.creative_list_voices({ context }));
    expect(Object.keys(all).sort()).toEqual(["has_more", "library_total", "total_count", "voices"]);
    expect(all).toMatchObject({ total_count: all.voices.length, has_more: false });
    const rachel = all.voices.find((v: { voice_id: string }) => v.voice_id === VOICE);
    expect(Object.keys(rachel).sort()).toEqual(
      ["category", "description", "is_library_voice", "labels", "name", "orb_url", "preview_url", "voice_id"],
    );
    expect(Object.keys(rachel.labels).sort()).toEqual(["accent", "age", "descriptive", "gender", "language", "use_case"]);
    // The live name carries a tagline.
    expect(rachel.name).toMatch(/^Rachel - /);
    const german = body(t.creative_list_voices({ languages: ["de"], context }));
    expect(german.voices.map((v: { voice_id: string }) => v.voice_id)).toEqual(["fakevoiceJonas00004"]);
    const female = body(t.creative_list_voices({ gender: "female", use_cases: ["social_media"], context }));
    expect(female.voices.map((v: { voice_id: string }) => v.voice_id)).toEqual(["fakevoiceMia0000003"]);
    expect(readCalls(home).at(-1)).toMatchObject({ tool: "creative_list_voices", input: { gender: "female", use_cases: ["social_media"], context } });
  });

  itWithFfmpeg("creative_generate_speech makes FOUR takes when generations_count is left out, and records that", async () => {
    const t = await load();
    const res = body(await t.creative_generate_speech({ prompt: "Meet AquaFlow.", model_id: "eleven_multilingual_v2", voice_id: VOICE, context }));
    expect(res.summary).toMatchObject({ nodes_run: 1, generations_started: 4, failed: 0, generations_by_node: { [res.node_id]: 4 } });
    expect(res.flow_id).toMatch(/^flow_fake_/);
    expect(res.flow_url).toBe(`https://elevenlabs.io/app/flows/${res.flow_id}`);
    // Four takes come back from the poll.
    t.creative_get_flow_run_status({ flow_id: res.flow_id, session_ids: res.session_ids, context });
    const done = body(t.creative_get_flow_run_status({ flow_id: res.flow_id, session_ids: res.session_ids, context }));
    expect(done.generations).toHaveLength(4);
    expect(done.media).toHaveLength(4);
    const call = readCalls(home).find((c) => c.tool === "creative_generate_speech");
    expect(call).toMatchObject({ tool: "creative_generate_speech", generations_count: 4, voice_id: VOICE, model_id: "eleven_multilingual_v2" });
    // The raw input has no count at all: the matcher `input.generations_count != 1` catches this call.
    expect(call.input.generations_count).toBeUndefined();
  });

  itWithFfmpeg("a speech run starts in the live shape, its first poll is still running, and the next puts the audio in media[] keyed by generation_id", async () => {
    const t = await load();
    const run = body(await t.creative_generate_speech({ prompt: "Hello there", model_id: "eleven_v3", voice_id: VOICE, generations_count: 1, context }));
    // The live start result, key for key.
    expect(Object.keys(run).sort()).toEqual([
      "flow_created", "flow_id", "flow_url", "node_id", "notes", "poll_after_seconds", "results", "session_ids", "summary", "url",
      "view_kind", "view_state_id",
    ]);
    expect(run).toMatchObject({
      flow_created: true, poll_after_seconds: 3, view_kind: "speech_generation",
      results: [{ success: true, node_id: run.node_id, session_id: run.session_ids[0] }],
      summary: { nodes_run: 1, generations_started: 1, failed: 0 },
    });
    expect(run.session_ids).toHaveLength(1);
    expect(run.url).toBe(`https://elevenlabs.io/app/flows/${run.flow_id}?vs=${run.view_state_id}`);

    const first = body(t.creative_get_flow_run_status({ flow_id: run.flow_id, session_ids: run.session_ids, context }));
    expect(first).toMatchObject({ all_completed: false, has_failures: false, poll_after_seconds: 3 });
    expect(first.media).toBeUndefined();

    const done = body(t.creative_get_flow_run_status({ flow_id: run.flow_id, session_ids: run.session_ids, context }));
    expect(done).toMatchObject({ all_completed: true, has_failures: false, flow_created: false, session_id: run.session_ids[0], session_ids: run.session_ids });
    expect(done.transcripts).toBeUndefined();
    const [gen] = done.generations;
    expect(gen).toMatchObject({ status: "completed", model_id: "eleven_v3", modality: "audio", prompt: "Hello there", price: { credits: 11, cost_fiat_currency: "usd" } });
    expect(gen.price.price_cents).toBeCloseTo(0.22);
    // The audio is NOT on the generation: it is in media[], joined by generation_id.
    expect(gen.output_url).toBeUndefined();
    expect(gen.url).toBeUndefined();
    const [m] = done.media;
    expect(m).toMatchObject({ generation_id: gen.id, kind: "audio", model_id: "eleven_v3", voice: { voice_id: VOICE } });
    expect(m.master_url).toBe(m.url);
    expect(m.url).toMatch(/^http:\/\/127\.0\.0\.1:3999\/api\/test-mode\/elevenlabs\/out\/el_tts_gen_fake_[a-f0-9]+\.mp3$/);
    // The URL resolves through the studio's test-mode route to a real MP3, as the live server's does.
    const { handleElevenLabsTestMedia } = await media();
    const name = m.url.split("/").pop();
    const served = handleElevenLabsTestMedia("GET", ["out", name], Buffer.alloc(0), {});
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toBe("audio/mpeg");
    expect(served.body.subarray(0, 3).toString()).toBe("ID3");
    expect(readCalls(home).at(-1)).toMatchObject({ tool: "creative_get_flow_run_status", output_urls: [m.url] });
  });

  it("refuses a voice that did not come from creative_list_voices, and records the refusal", async () => {
    const t = await load();
    const res = await t.creative_generate_speech({ prompt: "Hi", model_id: "eleven_v3", voice_id: "made-up-voice", generations_count: 1, context });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/creative_list_voices/);
    expect(readCalls(home).at(-1)).toMatchObject({ tool: "creative_generate_speech", rejected: true });
  });

  it("estimate_only answers in the live shape, prices the run for its generations_count, and starts nothing", async () => {
    const t = await load();
    const one = body(await t.creative_generate_speech({ prompt: "x".repeat(100), model_id: "eleven_multilingual_v2", voice_id: VOICE, generations_count: 1, estimate_only: true, context }));
    const four = body(await t.creative_generate_speech({ prompt: "x".repeat(100), model_id: "eleven_multilingual_v2", voice_id: VOICE, estimate_only: true, context }));
    expect(Object.keys(one).sort()).toEqual(["estimate", "flow_created", "flow_id", "node_id", "notes", "url"]);
    expect(one.estimate).toEqual({ credits: 100, price_cents: 2, generations_count: 1, currency: "usd", estimated_runtime_seconds: 3 });
    expect(four.estimate).toMatchObject({ credits: 400, generations_count: 4 });
    // Like the live server, an estimate creates a flow and a node — and nothing to poll.
    expect(one).toMatchObject({ flow_created: true, url: `https://elevenlabs.io/app/flows/${one.flow_id}` });
    expect(one.node_id).toMatch(/^node_fake_/);
    expect(one.notes).toMatch(/nothing was charged/);
    expect(one.session_ids).toBeUndefined();
    expect(existsSync(join(home, "test-mode", "elevenlabs-out"))).toBe(false);
    expect(readCalls(home).at(-1)).toMatchObject({ estimate_only: true, generations_count: 4 });
  });

  itWithFfmpeg("creative_generate_in_flow runs music and sound effects on their own models", async () => {
    const t = await load();
    const music = body(await t.creative_generate_in_flow({ prompt: "lofi beat", node_type: "music", model_id: "eleven_music_v2", generations_count: 1, context }));
    expect(music.session_ids).toHaveLength(1);
    const sfx = body(await t.creative_generate_in_flow({ prompt: "door creak", node_type: "sfx", model_id: "eleven_text_to_sound_v2", generations_count: 2, context }));
    // One session per node run; the takes are its generations.
    expect(sfx.session_ids).toHaveLength(1);
    expect(sfx.summary.generations_started).toBe(2);
    expect(readCalls(home).at(-1)).toMatchObject({ tool: "creative_generate_in_flow", node_type: "sfx", generations_count: 2 });
  });

  it("creative_generate_in_flow refuses a model from another node type, an unmirrored node type, and a changer with nothing wired", async () => {
    const t = await load();
    const wrong = await t.creative_generate_in_flow({ prompt: "x", node_type: "music", model_id: "eleven_v3", generations_count: 1, context });
    expect(wrong.isError).toBe(true);
    expect(wrong.content[0].text).toMatch(/eleven_music_v2/);
    const image = await t.creative_generate_in_flow({ prompt: "x", node_type: "image-generation", model_id: "gpt-image-2", generations_count: 1, context });
    expect(image.isError).toBe(true);
    const changer = await t.creative_generate_in_flow({ prompt: "x", node_type: "voice-changer", model_id: "eleven_multilingual_sts_v2", voice_id: VOICE, generations_count: 1, context });
    expect(changer.isError).toBe(true);
    expect(changer.content[0].text).toMatch(/connect_from/);
    const tts = await t.creative_generate_in_flow({ prompt: "x", node_type: "tts", model_id: "eleven_v3", generations_count: 1, context });
    expect(tts.content[0].text).toMatch(/voice_id is required/);
  });

  it("a status poll for a session of another flow is refused", async () => {
    const t = await load();
    const flow = body(t.creative_create_flow({ context }));
    const res = t.creative_get_flow_run_status({ flow_id: flow.flow_id, session_ids: ["sess_fake_nope"], context });
    expect(res.isError).toBe(true);
    expect(flow.url).toBe(`https://elevenlabs.io/app/flows/${flow.flow_id}`);
  });

  it("an upload is PUT with its exact Content-Type, then finalized onto a flow, then transcribed; the poll hands back FLAT text only", async () => {
    const t = await load();
    const { handleElevenLabsTestMedia } = await media();
    const bytes = Buffer.from("RIFF-fake-audio");
    const up = body(t.creative_create_asset_upload({ name: "clip.wav", mime_type: "audio/wav", file_size: bytes.length, context }));
    // The live result is exactly these three.
    expect(Object.keys(up).sort()).toEqual(["asset_id", "max_file_size_bytes", "upload_url"]);
    expect(up.max_file_size_bytes).toBe(209_715_200);
    expect(up.upload_url).toBe(`http://127.0.0.1:3999/api/test-mode/elevenlabs/upload/${up.asset_id}`);
    const flow = body(t.creative_create_flow({ name: "revoice", context }));

    // Finalizing before the bytes landed is refused.
    expect(t.creative_finalize_asset_upload({ asset_id: up.asset_id, flow_id: flow.flow_id, context }).isError).toBe(true);
    // A PUT whose Content-Type differs from the one the upload was started with is refused, like a presigned URL.
    expect(handleElevenLabsTestMedia("PUT", ["upload", up.asset_id], bytes, { "content-type": "application/octet-stream" }).status).toBe(403);
    expect(handleElevenLabsTestMedia("PUT", ["upload", up.asset_id], bytes, { "content-type": "audio/wav" }).status).toBe(200);

    const placed = body(t.creative_finalize_asset_upload({ asset_id: up.asset_id, flow_id: flow.flow_id, context }));
    expect(placed).toEqual({
      asset_id: up.asset_id, name: "clip.wav", mime_type: "audio/wav", size_bytes: bytes.length, flow_id: flow.flow_id, node_id: placed.node_id,
    });
    const run = body(await t.creative_transcribe_audio({ model_id: "eleven_scribe_v1", flow_id: flow.flow_id, connect_from: [placed.node_id], context }));
    expect(run).toMatchObject({ flow_id: flow.flow_id, flow_created: false, poll_after_seconds: 3 });
    expect(run.view_kind).toBeUndefined();
    t.creative_get_flow_run_status({ flow_id: flow.flow_id, session_ids: run.session_ids, context });
    const done = body(t.creative_get_flow_run_status({ flow_id: flow.flow_id, session_ids: run.session_ids, context }));
    expect(done.all_completed).toBe(true);
    expect(done.media).toBeUndefined();
    const [gen] = done.generations;
    expect(gen).toMatchObject({ status: "completed", model_id: "eleven_scribe_v1", modality: "text" });
    // Transcription is billed in FRACTIONAL credits.
    expect(Number.isInteger(gen.price.credits)).toBe(false);
    const [tr] = done.transcripts;
    expect(Object.keys(tr).sort()).toEqual(
      ["download_url", "generation_id", "language_code", "language_probability", "model_id", "source", "spoken_duration_secs", "text"],
    );
    expect(tr).toMatchObject({ generation_id: gen.id, model_id: "eleven_scribe_v1", source: { kind: "audio" } });
    expect(tr.text).toMatch(/placeholder transcript/);
    // No per-word timing, no speakers, no audio events: the live result has none of them.
    expect(tr.words).toBeUndefined();
    expect(JSON.stringify(done)).not.toMatch(/speaker|"words"|audio_event/);
    // download_url serves the same flat text; source.url serves the audio it read.
    const txt = handleElevenLabsTestMedia("GET", ["out", tr.download_url.split("/").pop()], Buffer.alloc(0), {});
    expect(txt.status).toBe(200);
    expect(txt.headers["content-type"]).toMatch(/^text\/plain/);
    expect(txt.body.toString()).toBe(tr.text);
    const src = handleElevenLabsTestMedia("GET", ["out", tr.source.url.split("/").pop()], Buffer.alloc(0), {});
    expect(src.body.toString()).toBe("RIFF-fake-audio");
  });

  it("an upload over the live 200 MiB ceiling is refused at the start", async () => {
    const t = await load();
    const res = t.creative_create_asset_upload({ name: "huge.wav", mime_type: "audio/wav", file_size: 209_715_201, context });
    expect(res.isError).toBe(true);
    expect(readCalls(home).at(-1)).toMatchObject({ tool: "creative_create_asset_upload", rejected: true });
  });

  it("finalizing without a flow answers the asset's metadata and no node", async () => {
    const t = await load();
    const { handleElevenLabsTestMedia } = await media();
    const up = body(t.creative_create_asset_upload({ name: "a.mp3", mime_type: "audio/mpeg", file_size: 3, context }));
    handleElevenLabsTestMedia("PUT", ["upload", up.asset_id], Buffer.from("ID3"), { "content-type": "audio/mpeg" });
    expect(body(t.creative_finalize_asset_upload({ asset_id: up.asset_id, context }))).toEqual({
      asset_id: up.asset_id, name: "a.mp3", mime_type: "audio/mpeg", size_bytes: 3,
    });
  });

  it("an upload whose size differs from the one declared is refused at finalize", async () => {
    const t = await load();
    const { handleElevenLabsTestMedia } = await media();
    const up = body(t.creative_create_asset_upload({ name: "a.wav", mime_type: "audio/wav", file_size: 99, context }));
    handleElevenLabsTestMedia("PUT", ["upload", up.asset_id], Buffer.from("short"), { "content-type": "audio/wav" });
    const res = t.creative_finalize_asset_upload({ asset_id: up.asset_id, context });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/5 bytes/);
  });

  it("connect_from must name a node on the flow passed", async () => {
    const t = await load();
    const flow = body(t.creative_create_flow({ context }));
    const res = await t.creative_transcribe_audio({ model_id: "eleven_scribe_v1", flow_id: flow.flow_id, connect_from: ["node_fake_elsewhere"], context });
    expect(res.isError).toBe(true);
  });

  it("creative_get_flow_node_types and creative_get_model_schema answer for the audio node types", async () => {
    const t = await load();
    const types = body(t.creative_get_flow_node_types({ context }));
    expect(types.node_types).toContainEqual({ node_type: "music", models: ["eleven_music_v2", "eleven_music_v1"], default_model: "eleven_music_v2" });
    const schema = body(t.creative_get_model_schema({ node_type: "music", model_id: "eleven_music_v2", context }));
    expect(schema.parameters.duration_seconds).toMatchObject({ type: "number" });
    // Nothing to switch diarization or timestamps on: the hosted transcript is flat text whatever the node runs.
    expect(body(t.creative_get_model_schema({ node_type: "speech-to-text", model_id: "eleven_scribe_v1", context })).parameters).toEqual({});
    expect(t.creative_get_model_schema({ node_type: "sfx", model_id: "eleven_music_v2", context }).isError).toBe(true);
  });
});

describe("fake-elevenlabs — every tool requires `context`, like the hosted server", () => {
  it("each schema refuses a call without it", async () => {
    const schemas = await import("@/mcp/dev/fake-elevenlabs/schemas");
    const all = [
      schemas.ListVoicesSchema, schemas.CreateFlowSchema, schemas.GenerateSpeechSchema, schemas.GenerateInFlowSchema,
      schemas.TranscribeAudioSchema, schemas.FlowRunStatusSchema, schemas.FlowNodeTypesSchema, schemas.ModelSchemaSchema,
      schemas.CreateAssetUploadSchema, schemas.FinalizeAssetUploadSchema,
    ];
    for (const schema of all) {
      const missing = schema.safeParse({});
      expect(missing.success).toBe(false);
      if (!missing.success) expect(missing.error.issues.map((i) => i.path.join("."))).toContain("context");
    }
    expect(schemas.GenerateSpeechSchema.safeParse({ prompt: "x", model_id: "eleven_v3", voice_id: "v", generations_count: 5, context: "c" }).success).toBe(false);
  });
});
