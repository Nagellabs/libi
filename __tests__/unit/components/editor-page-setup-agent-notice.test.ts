import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The editor's empty state shows "why the agent can't chat" plus a Set up an
 * agent link. Its message comes from the SERVER's readiness, so its link must
 * name the agent that readiness describes — not the optimistic
 * `activeProviderId`, which moves the instant the user picks another agent —
 * and while an agent switch is still connecting the readiness describes the
 * previous agent, so the notice stays hidden (the sidebar's rule).
 *
 * A source scan, like its siblings (editor-page-onboarding-reachable.test.ts,
 * editor-page-upload-files-piece-scoped.test.ts): rendering this page means
 * standing up a dozen providers, disproportionate to pinning one derivation.
 * What it proves: the derivation reads `isAgentConnecting` and the needs-auth
 * `agentId`, and the result reaches `NoPieceEmptyState`. What it does NOT
 * prove: the notice's rendering — `NoPieceEmptyState`'s own tests cover that.
 */
describe("editor page — the setup-agent notice", () => {
  const PAGE = join(process.cwd(), "app/(app)/editor/page.tsx");
  const source = readFileSync(PAGE, "utf8");

  /** The `const setupAgent… = …;` statements, joined. */
  function derivation(): string {
    const start = source.indexOf("const setupAgentMessage");
    expect(start, "setupAgentMessage derivation not found").toBeGreaterThan(-1);
    const end = source.indexOf("\n\n", start);
    return source.slice(start, end);
  }

  it("reads isAgentConnecting from the editor state", () => {
    const destructure = source.slice(
      source.indexOf("const {", source.indexOf("export default function EditorPage")),
      source.indexOf("} = useEditorState();"),
    );
    expect(destructure).toMatch(/\bisAgentConnecting\b/);
  });

  it("hides the notice while an agent switch is still connecting", () => {
    expect(derivation()).toMatch(/isAgentConnecting/);
  });

  it("links a needs-auth notice to the agent the server readiness names", () => {
    const d = derivation();
    expect(d).toMatch(/state === "needs-auth"/);
    expect(d).toMatch(/\.agentId/);
    expect(d).toMatch(/agentSetupHref\(/);
  });

  it("hands the notice to the empty state", () => {
    expect(source).toContain("setupAgent={setupAgent}");
  });
});
