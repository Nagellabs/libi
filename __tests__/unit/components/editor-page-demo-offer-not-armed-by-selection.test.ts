import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * QA-observed defect: the chat panel's Codex sign-in card ("Codex isn't
 * signed in on this machine, so libi can't start a chat with it.") rendered
 * directly beneath a green "You're all set!" demo-offer banner — two
 * contradictory claims in the same view. Confirmed against the DB at the
 * same moment: `agent_ever_connected = 0` and `onboarding_demo_offered_at =
 * NULL` — the server had NOT armed the offer.
 *
 * Root cause: this page had TWO sources arming `onboardingDemoOffer`.
 * lib/sessions/session-manager.ts#markAgentConnected (correct — fires only
 * on an observed clean `session/new`) and this page's own
 * `activeProviderId` effect (wrong — `activeProviderId` flips the moment an
 * agent is SELECTED, before the handshake that would prove it's actually
 * usable resolves or fails). The fix removes the latter; the effect keeps
 * its real job of leaving the onboarding takeover once an agent is chosen,
 * but must never itself claim the offer is armed.
 *
 * This is a source scan, not a render test, for the same reason as the
 * sibling file (editor-page-onboarding-reachable.test.ts): rendering this
 * page means standing up a dozen providers, disproportionate to what this
 * specific regression needs checked. The re-arming path this leaves in
 * place — re-reading /api/onboarding/state once `sessionList.readiness`
 * reaches "ready" — is covered behaviorally in
 * __tests__/unit/editor-state-context.test.tsx.
 */
describe("editor page — selecting an agent does not, by itself, arm the demo offer", () => {
  const PAGE = join(process.cwd(), "app/(app)/editor/page.tsx");
  const source = readFileSync(PAGE, "utf8");

  it("never calls setOnboardingDemoOffer from this page", () => {
    // The page used to own one of the two arming call sites for this flag.
    // It should no longer reference the setter at all — the offer is armed
    // exclusively server-side and re-read by the context, not pushed by any
    // page-level effect.
    expect(source).not.toContain("setOnboardingDemoOffer");
  });

  it("does NOT try to decide when to leave by watching provider state", () => {
    // Two state-watching effects were tried here and both failed identically:
    // at mount `activeProviderId` is briefly null and then populates, which is
    // indistinguishable from the user picking an agent, so the connect screen
    // closed the instant it opened. Leaving is driven by the ACTIONS that mean
    // it — see app-sidebar (new chat, agent selector) and onboarding-panel
    // (connect, Terminal).
    expect(source).not.toContain("providerOnEnterRef");
    expect(source).not.toContain("sessionOnEnterRef");
  });

  it("honours an explicit ?setup=agent request for the connect screen", () => {
    // The sidebar row asks for the screen by name. Unlike the first-run
    // auto-open, this must win mid-flow.
    expect(source).toContain('setupParam !== "agent"');
    expect(source).toContain('setRightRegionMode("onboarding");');
  });
});
