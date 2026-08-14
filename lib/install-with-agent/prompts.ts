export interface InstallPromptInput {
  id: string;
  name: string;
}

export interface RepairPromptInput {
  id: string;
  name: string;
  installError: string | null;
}

export function buildInstallPrompt(input: InstallPromptInput): string {
  return `Please install the ${input.name} MCP server (id: \`${input.id}\`).`;
}

export function buildRepairPrompt(input: RepairPromptInput): string {
  const basePrompt = `The ${input.name} MCP server (id: \`${input.id}\`) failed to install or run. Please diagnose and repair it.`;

  if (input.installError && input.installError.trim()) {
    return `${basePrompt}\n\nPrevious error:\n${input.installError}`;
  }

  return basePrompt;
}
