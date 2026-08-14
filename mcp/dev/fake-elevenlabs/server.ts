import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mcpLogger as logger } from "@/lib/logger";
import * as schemas from "./schemas";
import * as tools from "./tools";

export function createFakeElevenLabsMcpServer(): McpServer {
  const server = new McpServer({ name: "ElevenLabs", version: "0.1.0" });

  server.registerTool("text_to_speech",
    { title: "Text to speech", description: "Test-mode ElevenLabs mirror.", inputSchema: schemas.TextToSpeechSchema },
    async (a) => tools.text_to_speech(a));
  server.registerTool("text_to_sound_effects",
    { title: "Text to sound effects", description: "Test-mode ElevenLabs mirror.", inputSchema: schemas.TextToSoundEffectsSchema },
    async (a) => tools.text_to_sound_effects(a));
  server.registerTool("compose_music",
    { title: "Compose music", description: "Test-mode ElevenLabs mirror.", inputSchema: schemas.ComposeMusicSchema },
    async (a) => tools.compose_music(a));
  server.registerTool("isolate_audio",
    { title: "Isolate audio", description: "Test-mode ElevenLabs mirror.", inputSchema: schemas.IsolateAudioSchema },
    async (a) => tools.isolate_audio(a));
  server.registerTool("voice_clone",
    { title: "Voice clone", description: "Test-mode ElevenLabs mirror.", inputSchema: schemas.VoiceCloneSchema },
    async (a) => tools.voice_clone(a));
  server.registerTool("speech_to_text",
    { title: "Speech to text", description: "Test-mode ElevenLabs mirror.", inputSchema: schemas.SpeechToTextSchema },
    async (a) => tools.speech_to_text(a));

  logger.info({ tag: "fake-elevenlabs" }, "fake-elevenlabs MCP server created (masquerading as ElevenLabs)");
  return server;
}
