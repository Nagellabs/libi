import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpLogger as logger } from "@/lib/logger";
import * as schemas from "./schemas";
import * as tools from "./tools";

/**
 * The test-mode ElevenLabs: the creative tools libi's skills use on ElevenLabs'
 * hosted MCP, under the same names and parameters (./schemas.ts), at zero cost.
 * Its `agents_*` conversational-agent tools, brand kits and image / video
 * generation are not mirrored: no libi skill uses them.
 */
export function createFakeElevenLabsMcpServer(): McpServer {
  const server = new McpServer({ name: "elevenlabs", version: "0.2.0" });
  const mirror = (what: string) => `Test-mode ElevenLabs mirror. ${what}`;

  server.registerTool("creative_list_voices",
    { title: "List voices", description: mirror("Searches the voices the workspace can use for speech."), inputSchema: schemas.ListVoicesSchema },
    async (a) => tools.creative_list_voices(a));
  server.registerTool("creative_create_flow",
    { title: "Create flow", description: mirror("Creates an empty flow (canvas). Create one first whenever several generations must be connected."), inputSchema: schemas.CreateFlowSchema },
    async (a) => tools.creative_create_flow(a));
  server.registerTool("creative_generate_speech",
    { title: "Generate speech", description: mirror("Generates speech from text with a chosen voice. Charges credits for each of generations_count takes (default 4). Returns flow_id, node_id and session_ids to poll, not the audio."), inputSchema: schemas.GenerateSpeechSchema },
    async (a) => tools.creative_generate_speech(a));
  server.registerTool("creative_generate_in_flow",
    { title: "Generate in flow", description: mirror("Creates a node of any type and starts generating in one call. Charges credits for each of generations_count takes (default 4)."), inputSchema: schemas.GenerateInFlowSchema },
    async (a) => tools.creative_generate_in_flow(a));
  server.registerTool("creative_transcribe_audio",
    { title: "Transcribe audio", description: mirror("Transcribes speech in an audio node to text; the transcript (flat text) comes back in `transcripts` from the run-status poll."), inputSchema: schemas.TranscribeAudioSchema },
    async (a) => tools.creative_transcribe_audio(a));
  server.registerTool("creative_get_flow_run_status",
    { title: "Get flow run status", description: mirror("Polls a run until it finishes and reads its generations: audio in `media` (a short-lived url per generation_id), text in `transcripts`."), inputSchema: schemas.FlowRunStatusSchema },
    async (a) => tools.creative_get_flow_run_status(a));
  server.registerTool("creative_get_flow_node_types",
    { title: "Get flow node types", description: mirror("Lists the node types and models this workspace can run in its region."), inputSchema: schemas.FlowNodeTypesSchema },
    async (a) => tools.creative_get_flow_node_types(a));
  server.registerTool("creative_get_model_schema",
    { title: "Get model schema", description: mirror("Reads a model's configurable parameters."), inputSchema: schemas.ModelSchemaSchema },
    async (a) => tools.creative_get_model_schema(a));
  server.registerTool("creative_create_asset_upload",
    { title: "Create asset upload", description: mirror("Starts a local-file upload by returning a presigned URL to PUT the file's bytes to. The PUT Content-Type must exactly match mime_type."), inputSchema: schemas.CreateAssetUploadSchema },
    async (a) => tools.creative_create_asset_upload(a));
  server.registerTool("creative_finalize_asset_upload",
    { title: "Finalize asset upload", description: mirror("Confirms an upload landed and optionally places the file on a flow as a node."), inputSchema: schemas.FinalizeAssetUploadSchema },
    async (a) => tools.creative_finalize_asset_upload(a));

  logger.info({ tag: "fake-elevenlabs" }, "fake-elevenlabs MCP server created (masquerading as ElevenLabs)");
  return server;
}
