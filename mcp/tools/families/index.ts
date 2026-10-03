/**
 * The merged tools, in registration order. `mcp/server.ts` registers each with
 * `registerActionTool`; the names must match `lib/agents/merged-tools.ts`.
 */
import type { ActionToolDef } from "@/mcp/tools/action-tool";
import { captionStyleTool } from "./caption-style";
import { audioDuckTool } from "./audio-duck";
import { jobTool } from "./job";
import { keyframeTool } from "./keyframe";
import { showTool } from "./show";
import { skillTool } from "./skill";
import { characterTool, catalogItemTool } from "./catalog";
import { templateTool } from "./template";
import { extensionTool } from "./extension";
import { analysisSaveTool, analysisQueryTool, analysisExtractTool } from "./analysis";
import { layerEffectTool } from "./layer-effect";
import { pieceFolderTool } from "./folder";
import { assetFolderTool } from "./asset-folder";
import { clipTool } from "./clip";
import { audioClipTool } from "./audio-clip";
import { audioAnalyzeTool } from "./audio-analyze";
import { storyboardTakeTool } from "./storyboard-take";
import { modelSchemaCacheTool } from "./model-schema-cache";
import { effectTool } from "./effect";
import { overlayPresetTool } from "./overlay-preset";
import { snapshotTool } from "./snapshot";
import { socialLinkTool } from "./social-link";

export const MERGED_TOOLS: readonly ActionToolDef[] = [
  captionStyleTool,
  audioDuckTool,
  jobTool,
  keyframeTool,
  showTool,
  skillTool,
  characterTool,
  catalogItemTool,
  templateTool,
  extensionTool,
  analysisSaveTool,
  analysisQueryTool,
  analysisExtractTool,
  layerEffectTool,
  pieceFolderTool,
  assetFolderTool,
  clipTool,
  audioClipTool,
  audioAnalyzeTool,
  storyboardTakeTool,
  modelSchemaCacheTool,
  effectTool,
  overlayPresetTool,
  snapshotTool,
  socialLinkTool,
];

// The tracking family (`libi.track`, `libi.tracked_overlay`) is NOT in this list: `registerTrackingTools`
// (mcp/tracking-mcp/register-tracking-tools.ts) registers it, because that one function is shared by the
// core server and the standalone `libi serve-mcp-tracking` surface. See ./tracking.ts.
export { TRACKING_MERGED_TOOLS } from "./tracking";
