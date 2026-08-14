/** ACP-native session types and queries */

// ── Types ───────────────────────────────────────────────────────────

export interface SessionSummary {
  sessionId: string;
  title: string | null;
  updatedAt: string | null;
}

export interface AgentCapabilities {
  canListSessions: boolean;
}

export interface SessionsResponse {
  sessions: SessionSummary[];
  capabilities: AgentCapabilities;
}
