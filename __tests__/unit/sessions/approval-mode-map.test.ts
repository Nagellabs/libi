import { describe, it, expect } from "vitest";
import { acpModeFor } from "@/lib/sessions/approval-mode-map";
import type { ApprovalMode } from "@/lib/approval/mode";

// The advertised-mode sets each ACP adapter reports via
// `result.modes?.availableModes`.
const CLAUDE_MODES = [
  { id: "default" },
  { id: "acceptEdits" },
  { id: "bypassPermissions" },
];
const CODEX_MODES = [
  { id: "read-only" },
  { id: "auto" },
  { id: "full-access" },
];

describe("acpModeFor", () => {
  describe("claude-code vocabulary", () => {
    it("maps ask → default", () => {
      expect(acpModeFor("claude-code", "ask", CLAUDE_MODES)).toBe("default");
    });

    it("maps auto → bypassPermissions", () => {
      expect(acpModeFor("claude-code", "auto", CLAUDE_MODES)).toBe(
        "bypassPermissions",
      );
    });

    it("maps auto-with-generations → bypassPermissions", () => {
      expect(
        acpModeFor("claude-code", "auto-with-generations", CLAUDE_MODES),
      ).toBe("bypassPermissions");
    });
  });

  describe("codex vocabulary", () => {
    it("maps ask → auto (NOT read-only — the agent must write overlay-code files)", () => {
      expect(acpModeFor("codex", "ask", CODEX_MODES)).toBe("auto");
    });

    it("maps auto → full-access", () => {
      expect(acpModeFor("codex", "auto", CODEX_MODES)).toBe("full-access");
    });

    it("maps auto-with-generations → full-access", () => {
      expect(
        acpModeFor("codex", "auto-with-generations", CODEX_MODES),
      ).toBe("full-access");
    });

    // The core regression guard: the bug was libi pushing Claude's
    // `bypassPermissions` to codex → ACP -32602 approval.mode.set_failed.
    it("NEVER returns bypassPermissions for codex under any input", () => {
      const modes: ApprovalMode[] = ["ask", "auto", "auto-with-generations"];
      const inputs: (Array<{ id: string }> | undefined)[] = [
        CODEX_MODES,
        CLAUDE_MODES, // even if fed Claude's advertised set
        [{ id: "bypassPermissions" }], // even if bypassPermissions is advertised
        undefined,
      ];
      for (const mode of modes) {
        for (const available of inputs) {
          expect(acpModeFor("codex", mode, available)).not.toBe(
            "bypassPermissions",
          );
        }
      }
    });
  });

  describe("advertised-mode gating", () => {
    it("returns null when the mapped id is absent from availableModes (claude)", () => {
      // bypassPermissions not advertised → cannot push it blind
      const restricted = [{ id: "default" }, { id: "acceptEdits" }];
      expect(acpModeFor("claude-code", "auto", restricted)).toBeNull();
    });

    it("returns null when the mapped id is absent from availableModes (codex)", () => {
      // full-access not advertised → cannot push it blind
      const restricted = [{ id: "read-only" }, { id: "auto" }];
      expect(
        acpModeFor("codex", "auto-with-generations", restricted),
      ).toBeNull();
    });

    it("still maps when availableModes DOES advertise the target", () => {
      expect(acpModeFor("codex", "auto", CODEX_MODES)).toBe("full-access");
    });
  });

  describe("unmapped / unknown agents", () => {
    it("returns null for an unmapped agent even when availableModes is provided", () => {
      expect(
        acpModeFor("gemini", "auto", [{ id: "default" }]),
      ).toBeNull();
    });

    it("returns null for an unmapped agent when availableModes is undefined", () => {
      expect(acpModeFor("gemini", "auto", undefined)).toBeNull();
    });
  });

  describe("undefined availableModes for a mapped agent", () => {
    it("returns null (never push blind) when availableModes is undefined", () => {
      // No cached advertised set → we must not push an unverified id.
      expect(acpModeFor("claude-code", "auto", undefined)).toBeNull();
      expect(acpModeFor("codex", "auto", undefined)).toBeNull();
    });
  });
});
