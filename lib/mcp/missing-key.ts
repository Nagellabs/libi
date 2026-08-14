export interface McpMissingKeyError {
  error: "mcp_missing_key";
  data: { mcpId: string; envVar: string; hint: string };
}

export function mcpMissingKeyError(mcpId: string, envVar: string): McpMissingKeyError {
  return {
    error: "mcp_missing_key",
    data: {
      mcpId,
      envVar,
      hint: `The ${mcpId} MCP needs ${envVar}. Call libi.show_api_config({ mcpId: "${mcpId}" }) and ask the user to enter it.`,
    },
  };
}
