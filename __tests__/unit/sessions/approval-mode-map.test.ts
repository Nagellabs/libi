import { describe, it, expect } from "vitest";
import { acpModeFor } from "@/lib/sessions/approval-mode-map";
import type { ApprovalMode } from "@/lib/approval/mode";

// The advertised-mode sets each ACP adapter reports via
// `result.modes?.availableModes`.
//
// claude-agent-acp 0.75.1 advertises `default | acceptEdits | plan | auto`
// always, and `bypassPermissions` only when `ALLOW_BYPASS`
// (dist/session-mode.js:189-224; dist/permissions/modes.js:1-3 — false for a
// root, non-sandbox process).
const CLAUDE_MODES = [
  { id: "default" },
  { id: "acceptEdits" },
  { id: "plan" },
  { id: "auto" },
  { id: "bypassPermissions" },
];
// The same adapter running as root (no `IS_SANDBOX`): no `bypassPermissions`.
const CLAUDE_MODES_ROOT = CLAUDE_MODES.filter((m) => m.id !== "bypassPermissions");
// codex-acp 1.10.0 (`AgentMode.all()` in dist/index.js).
const CODEX_MODES = [
  { id: "read-only" },
  { id: "agent" },
  { id: "agent-full-access" },
];
// codex-acp ≤ 1.6.x vocabulary — what a runtime installed by an older libi
// still advertises.
const CODEX_LEGACY_MODES = [
  { id: "read-only" },
  { id: "auto" },
  { id: "full-access" },
];

describe("acpModeFor", () => {
  describe("claude-code vocabulary", () => {
    it("maps ask → default", () => {
      expect(acpModeFor("claude-code", "ask", CLAUDE_MODES)).toBe("default");
    });

    // The extension approval gate lives in libi's `canUseTool` handler.
    // claude-agent-acp applies `bypassPermissions` BEFORE invoking canUseTool,
    // so pushing bypass for `auto` would mean the gate never runs.
    it("maps auto → default (NOT bypassPermissions — bypass skips libi's permission handler)", () => {
      expect(acpModeFor("claude-code", "auto", CLAUDE_MODES)).toBe("default");
    });

    it("maps auto-with-generations → bypassPermissions (the never-prompt mode)", () => {
      expect(
        acpModeFor("claude-code", "auto-with-generations", CLAUDE_MODES),
      ).toBe("bypassPermissions");
    });

    // Under root the adapter never advertises `bypassPermissions`, so the
    // never-prompt mode has nothing to push: null → the caller skips and
    // warns, and the session stays in the adapter's own default (`default`),
    // where gated extensions still prompt.
    it("returns null for auto-with-generations when bypassPermissions is not advertised (root)", () => {
      expect(
        acpModeFor("claude-code", "auto-with-generations", CLAUDE_MODES_ROOT),
      ).toBeNull();
      // …while the two permission-routing modes are unaffected.
      expect(acpModeFor("claude-code", "ask", CLAUDE_MODES_ROOT)).toBe("default");
      expect(acpModeFor("claude-code", "auto", CLAUDE_MODES_ROOT)).toBe("default");
    });
  });

  describe("codex vocabulary (codex-acp 1.10.0)", () => {
    // `read-only` is NOT a read-only sandbox: codex-acp 1.10.0 gives it
    // `sandboxMode: "workspace-write"` like `agent`. What differs is
    // `approvalsReviewer: "user"` vs `"auto_review"` — in `read-only` codex
    // asks the USER for commands and file changes, which is what "Ask each
    // time" promises.
    it("maps ask → read-only (reviewer user: codex asks the user, and still writes the workspace)", () => {
      expect(acpModeFor("codex", "ask", CODEX_MODES)).toBe("read-only");
    });

    it("maps auto → agent (approvalPolicy on-request, so request_permission still reaches libi)", () => {
      expect(acpModeFor("codex", "auto", CODEX_MODES)).toBe("agent");
    });

    it("maps auto-with-generations → agent-full-access (approvalPolicy never)", () => {
      expect(
        acpModeFor("codex", "auto-with-generations", CODEX_MODES),
      ).toBe("agent-full-access");
    });

    it("falls back to the legacy ids when only those are advertised", () => {
      // `read-only` exists in both vocabularies.
      expect(acpModeFor("codex", "ask", CODEX_LEGACY_MODES)).toBe("read-only");
      expect(acpModeFor("codex", "auto", CODEX_LEGACY_MODES)).toBe("auto");
      expect(
        acpModeFor("codex", "auto-with-generations", CODEX_LEGACY_MODES),
      ).toBe("full-access");
    });

    it("prefers the current id when both vocabularies are advertised", () => {
      const both = [...CODEX_MODES, ...CODEX_LEGACY_MODES];
      expect(acpModeFor("codex", "auto", both)).toBe("agent");
      expect(acpModeFor("codex", "auto-with-generations", both)).toBe(
        "agent-full-access",
      );
    });

    // The core regression guard: the bug was libi pushing Claude's
    // `bypassPermissions` to codex → ACP -32602 approval.mode.set_failed.
    it("NEVER returns bypassPermissions for codex under any input", () => {
      const modes: ApprovalMode[] = ["ask", "auto", "auto-with-generations"];
      const inputs: (Array<{ id: string }> | undefined)[] = [
        CODEX_MODES,
        CODEX_LEGACY_MODES,
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
      // default not advertised (hypothetical) → cannot push it blind
      const restricted = [{ id: "acceptEdits" }, { id: "bypassPermissions" }];
      expect(acpModeFor("claude-code", "auto", restricted)).toBeNull();
    });

    it("returns null when the mapped id is absent from availableModes (codex)", () => {
      // neither agent-full-access nor legacy full-access advertised
      const restricted = [{ id: "read-only" }, { id: "agent" }];
      expect(
        acpModeFor("codex", "auto-with-generations", restricted),
      ).toBeNull();
    });

    it("still maps when availableModes DOES advertise the target", () => {
      expect(acpModeFor("codex", "auto", CODEX_MODES)).toBe("agent");
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
