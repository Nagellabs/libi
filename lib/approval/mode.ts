export type ApprovalMode = "ask" | "auto" | "auto-with-generations";

export const APPROVAL_MODES: readonly ApprovalMode[] = [
  "ask",
  "auto",
  "auto-with-generations",
] as const;

export const DEFAULT_APPROVAL_MODE: ApprovalMode = "auto";

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return typeof value === "string" && APPROVAL_MODES.includes(value as ApprovalMode);
}

export function shouldPromptForAcp(mode: ApprovalMode): boolean {
  return mode === "ask";
}

export const APPROVAL_MODE_LABELS: Record<ApprovalMode, string> = {
  ask: "Ask each time",
  auto: "Auto",
  "auto-with-generations": "Auto, no extension prompts",
};

export const APPROVAL_MODE_DESCRIPTIONS: Record<ApprovalMode, string> = {
  ask: "Approve every tool call before it runs.",
  auto: "Run tools automatically. libi extensions marked “requires approval” still ask first.",
  "auto-with-generations":
    "Run everything automatically — including extensions marked “requires approval”. Your provider MCPs keep their own approval behaviour.",
};
