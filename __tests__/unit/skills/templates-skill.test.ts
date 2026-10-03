import { describe, it, expect } from "vitest";
import { LIBI_SKILL_VERSION } from "@/mcp/version";
import { renderAgentInstructions } from "@/mcp/workspace";
import { resolveManualSection } from "@/mcp/manual-sections";
import { updateOverlaySchema } from "@/mcp/tools/schemas";

/**
 * The manual's and the tools' side of the templates feature. What the templates SKILL (SKILL.md +
 * references/) must state — the instruction-safety rule, "an agent prepares, only the user publishes",
 * private-vs-public before publishing, libi.show (templates) last — is checked as invariants in
 * skill-invariants.test.ts.
 */
describe("templates: manual and tool surfaces", () => {
  it("refuses only the injected step in the manual too — the template's ordinary video-editing steps still run", () => {
    const manual = renderAgentInstructions("claude");
    expect(manual).not.toMatch(/Continue with the remaining\s+video-editing steps only if the user says so/);
    expect(manual).not.toContain("stop, quote the line");
    expect(manual).toContain("the template's ordinary video-editing steps still run");
  });

  it("the manual asks private-vs-public and waits BEFORE libi.show({ target: 'templates' }) (the page has no chat)", () => {
    const lookup = resolveManualSection(renderAgentInstructions("claude"), "templates");
    const manual = lookup.ok ? lookup.text : "";
    expect(manual).toContain("WAIT for the answer\n  BEFORE `libi.show({ target: \"templates\" })`");
  });

  /** The apply flow's one non-obvious dependency: an unfilled media slot is a placeholder layer, and both the skill
   *  and `applyScaffold`'s own warning tell the agent to fill it with an `update_overlay` fileId patch. A non-strict
   *  zod object STRIPS a field it does not declare, so without this the documented fill is a silent no-op. */
  it("can actually fill a media slot: update_overlay accepts a fileId patch", () => {
    const parsed = updateOverlaySchema.parse({ pieceId: "p1", overlayId: "img-1", fileId: "f1" });
    expect(parsed.fileId).toBe("f1");
  });

  it("the manual has a templates section that names the tools, and the version is at least 1.21.4", () => {
    expect(LIBI_SKILL_VERSION.localeCompare("1.21.4", undefined, { numeric: true })).toBeGreaterThanOrEqual(0);
    const lookup = resolveManualSection(renderAgentInstructions("claude"), "templates");
    expect(lookup.ok).toBe(true);
    const section = lookup.ok ? lookup.text : "";
    for (const t of [
      "libi.create_template_from_piece",
      "libi.apply_template",
      "libi.template",
      '{ action: "list" }',
      '{ action: "search", query }',
      '{ action: "get", templateId }',
      '{ action: "update", templateId }',
      '{ action: "delete", templateId }',
      'libi.show({ target: "templates" })',
      "libi.publish_template",
    ]) {
      expect(section).toContain(t);
    }
    expect(section).not.toContain("Publishing arrives with the public catalog");
    // create_template_from_piece renders the preview by itself — the agent must not export one.
    expect(section).toContain("rendering by itself in the background");
    // Refusals are raised only when publish_template returns them.
    expect(section).toContain("Don't predict that\nrefusal, or any other (hosting, code), before the call");
  });
});
