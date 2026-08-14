import { getSettings, updateSettings } from "@/lib/db/settings";
import { type ApprovalMode, DEFAULT_APPROVAL_MODE, isApprovalMode } from "./mode";

export type ApprovalModeMap = Record<string, ApprovalMode>;

function read(): ApprovalModeMap {
  const raw = getSettings().agentApprovalModes;
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: ApprovalModeMap = {};
    for (const [agentId, value] of Object.entries(parsed)) {
      if (isApprovalMode(value)) out[agentId] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function getApprovalMode(agentId: string): ApprovalMode {
  return read()[agentId] ?? DEFAULT_APPROVAL_MODE;
}

export function getAllApprovalModes(): ApprovalModeMap {
  return read();
}

export function setApprovalMode(agentId: string, mode: ApprovalMode): void {
  const current = read();
  current[agentId] = mode;
  updateSettings({ agentApprovalModes: JSON.stringify(current) });
}
