// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent, type RenderResult } from "@testing-library/react";
import { getAgentSetup } from "@/lib/agents/setup/registry";
import { AgentSetupCard } from "@/components/agents/agent-setup-card";
import { ManualInstructionsBlock } from "@/components/agents/manual-instructions";

const noop = () => {};

beforeEach(() => {
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("AgentSetupCard — the alignment guarantee", () => {
  it("renders the identical structure for both agents", () => {
    const claude = render(
      <AgentSetupCard
        setup={getAgentSetup("claude-code")!}
        mode="sign-in"
        state={{ kind: "idle" }}
        surface="onboarding"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    const codex = render(
      <AgentSetupCard
        setup={getAgentSetup("codex")!}
        mode="sign-in"
        state={{ kind: "idle" }}
        surface="onboarding"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    // Same roles, same order, same count. Only the text differs.
    const shape = (c: RenderResult) =>
      Array.from(c.container.querySelectorAll("button, ol, li, code")).map((e) => e.tagName);
    expect(shape(claude)).toEqual(shape(codex));
  });

  it("always shows the manual route beside the button", () => {
    const { getByRole, getAllByRole } = render(
      <AgentSetupCard
        setup={getAgentSetup("codex")!}
        mode="sign-in"
        state={{ kind: "idle" }}
        surface="sidebar"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    expect(getByRole("button", { name: /sign in/i })).toBeTruthy();
    expect(getAllByRole("listitem")).toHaveLength(3);
  });

  it("names the real cause when an install fails, and offers a retry", () => {
    const { getByText, getByRole } = render(
      <AgentSetupCard
        setup={getAgentSetup("claude-code")!}
        mode="install"
        state={{ kind: "failed", reason: "npm exited with code 1" }}
        surface="onboarding"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    expect(getByText(/npm exited with code 1/)).toBeTruthy();
    expect(getByRole("button", { name: /retry/i })).toBeTruthy();
    // The string this whole stage exists to delete.
    expect(document.body.textContent).not.toMatch(/restart libi/i);
  });

  it("shows real progress while installing, not a spinner", () => {
    const { getByRole } = render(
      <AgentSetupCard
        setup={getAgentSetup("claude-code")!}
        mode="install"
        state={{ kind: "working", doneMb: 108, totalMb: 250 }}
        surface="onboarding"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    const bar = getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("108");
    expect(bar.getAttribute("aria-valuemax")).toBe("250");
  });

  it("leads with Start chat when the caller can offer one, keeping sign-in beside it", () => {
    // The connect screen: nothing observed, so the card offers both and lets
    // the majority (already signed in) go first. Sign-in stays a real button
    // — the minority must not have to fail first to find it.
    const onStartChat = vi.fn();
    const onAction = vi.fn();
    const { getByRole } = render(
      <AgentSetupCard
        setup={getAgentSetup("codex")!}
        mode="sign-in"
        state={{ kind: "idle" }}
        surface="onboarding"
        onStartChat={onStartChat}
        onAction={onAction}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    fireEvent.click(getByRole("button", { name: /^start chat$/i }));
    expect(onStartChat).toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: /^sign in to codex$/i }));
    expect(onAction).toHaveBeenCalled();
  });

  it("separates the two routes with an explicit or", () => {
    // They are two routes, not an action and its modifier — and which one
    // applies depends on something libi cannot see. Adjacent with nothing
    // between them, the second reads as a qualifier on the first.
    const { container, rerender } = render(
      <AgentSetupCard
        setup={getAgentSetup("codex")!}
        mode="sign-in"
        state={{ kind: "idle" }}
        surface="onboarding"
        onStartChat={noop}
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    const row = container.querySelector('[data-slot="agent-setup-card"] > div:nth-of-type(2)');
    expect(row?.textContent).toMatch(/start chat\s*or\s*sign in to codex/i);

    // …and no stray "or" on the single-route card, where there is nothing
    // to choose between.
    rerender(
      <AgentSetupCard
        setup={getAgentSetup("codex")!}
        mode="sign-in"
        state={{ kind: "idle" }}
        surface="chat"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    const soloRow = container.querySelector('[data-slot="agent-setup-card"] > div:nth-of-type(2)');
    expect(soloRow?.textContent?.trim()).toBe("Sign in to Codex");
  });

  it("makes sign-in the primary again where an auth rejection HAS been observed", () => {
    // Chat and sidebar pass no onStartChat: there we know the agent said no,
    // so offering to start a chat would be offering something we know fails.
    const onAction = vi.fn();
    const { getByRole, queryByRole } = render(
      <AgentSetupCard
        setup={getAgentSetup("codex")!}
        mode="sign-in"
        state={{ kind: "idle" }}
        surface="chat"
        onAction={onAction}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    expect(queryByRole("button", { name: /start chat/i })).toBeNull();
    fireEvent.click(getByRole("button", { name: /^sign in to codex$/i }));
    expect(onAction).toHaveBeenCalled();
  });

  it("never asserts a sign-in state it has not observed", () => {
    // The card is an OFFER. It may say "Sign in to Codex"; it may not say
    // "not signed in" unless the caller passes an observed needs-auth reason.
    const { container } = render(
      <AgentSetupCard
        setup={getAgentSetup("codex")!}
        mode="sign-in"
        state={{ kind: "idle" }}
        surface="chat"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    expect(container.textContent).not.toMatch(/not signed in/i);
  });

  it("marks every control as clickable", () => {
    const { container } = render(
      <AgentSetupCard
        setup={getAgentSetup("claude-code")!}
        mode="sign-in"
        state={{ kind: "idle" }}
        surface="onboarding"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    const buttons = container.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const b of buttons) {
      expect(b.className).toContain("cursor-pointer");
    }
  });

  it("copies the command libi would actually run, not the readable short form", () => {
    // libi puts nothing on PATH, so the short form ("claude") fails on the
    // very machines this card exists for. The Copy button must hand over the
    // resolved command, not the prose-readable one shown in the steps.
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { getByRole } = render(
      <AgentSetupCard
        setup={getAgentSetup("claude-code")!}
        mode="sign-in"
        state={{ kind: "idle" }}
        surface="onboarding"
        resolvedCommand="/very/long/resolved/node_modules/path/to/claude"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    getByRole("button", { name: /copy/i }).click();
    expect(writeText).toHaveBeenCalledWith("/very/long/resolved/node_modules/path/to/claude");
  });

  it("still shows the readable short form in the steps", () => {
    // A 120-character node_modules path printed in prose reads like a bug —
    // the numbered steps keep the short form even when a resolved command
    // is available for the Copy button.
    const { getAllByRole } = render(
      <AgentSetupCard
        setup={getAgentSetup("claude-code")!}
        mode="sign-in"
        state={{ kind: "idle" }}
        surface="onboarding"
        resolvedCommand="/very/long/resolved/node_modules/path/to/claude"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    const items = getAllByRole("listitem");
    expect(items[0].querySelector("code")?.textContent).toBe("claude");
  });

  it("falls back to the short form when no command has been resolved yet", () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const { getByRole } = render(
      <AgentSetupCard
        setup={getAgentSetup("claude-code")!}
        mode="sign-in"
        state={{ kind: "idle" }}
        surface="onboarding"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    getByRole("button", { name: /copy/i }).click();
    expect(writeText).toHaveBeenCalledWith("claude");
  });

  it("disables the action button and shows the busy label while a busy action is in flight", () => {
    // Distinct from `working`, which reports real bytes — this is "an
    // action is in flight with no measurable progress" (connecting to an
    // agent, handing a sign-in command to the terminal). No spinner: this
    // repo's convention is skeletons that mirror the real layout, never
    // spinners or "Loading…" text — a disabled button whose own label says
    // what's happening is the honest, convention-respecting form.
    const { getByRole, getAllByRole } = render(
      <AgentSetupCard
        setup={getAgentSetup("claude-code")!}
        mode="sign-in"
        state={{ kind: "busy", label: "Connecting…" }}
        surface="onboarding"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    const button = getByRole("button", { name: /connecting/i });
    expect(button).toBeDisabled();
    expect(button.className).toContain("cursor-pointer");
    expect(document.querySelector(".animate-spin")).toBeNull();
    // The manual route stays visible — it's more useful while a connect is
    // dragging, not less.
    expect(getAllByRole("listitem")).toHaveLength(3);
  });

  it("renders no action button and no manual block when install mode has nothing to install", () => {
    // Codex ships with libi. Offering to install it is the exact bug this
    // project already had once: telling a user to install something they
    // already have, to fix a problem installing does not fix.
    const { container, queryByRole } = render(
      <AgentSetupCard
        setup={getAgentSetup("codex")!}
        mode="install"
        state={{ kind: "idle" }}
        surface="onboarding"
        onAction={noop}
        onRetry={noop}
        onCancel={noop}
      />,
    );
    expect(queryByRole("button")).toBeNull();
    expect(container.querySelectorAll("ol").length).toBe(0);
  });
});

describe("ManualInstructionsBlock", () => {
  const steps = getAgentSetup("claude-code")!.signIn.manual;

  it("substitutes {cmd} with an inline <code> element, not raw text", () => {
    const { container } = render(
      <ManualInstructionsBlock steps={steps} copyCommand="claude" />,
    );
    const items = container.querySelectorAll("li");
    expect(items).toHaveLength(3);
    // Step 1 carries the command — rendered as a real <code> node, and the
    // literal placeholder must never leak into the text.
    expect(items[0].querySelector("code")?.textContent).toBe("claude");
    expect(container.textContent).not.toContain("{cmd}");
  });

  it("always renders open — never behind a starts-closed disclosure", () => {
    render(<ManualInstructionsBlock steps={steps} copyCommand="claude" />);
    // The steps are immediately in the accessibility tree, no expand click
    // needed first.
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    expect(screen.getByText(/or do it yourself/i)).toBeTruthy();
  });

  it("copies the REAL command, not the short form shown in the steps", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const onCopy = vi.fn();
    const { getByRole } = render(
      <ManualInstructionsBlock
        steps={steps}
        copyCommand="/very/long/resolved/path/to/claude"
        onCopy={onCopy}
      />,
    );
    await act(async () => {
      getByRole("button", { name: /copy/i }).click();
    });
    expect(writeText).toHaveBeenCalledWith("/very/long/resolved/path/to/claude");
    expect(onCopy).toHaveBeenCalled();
  });

  it("leaves the label alone when the clipboard write fails", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    const onCopy = vi.fn();
    const { getByRole } = render(
      <ManualInstructionsBlock steps={steps} copyCommand="claude" onCopy={onCopy} />,
    );
    const button = getByRole("button", { name: /copy/i });
    await act(async () => {
      button.click();
    });
    expect(getByRole("button", { name: /copy/i })).toBe(button);
    expect(button.textContent).toMatch(/copy/i);
    expect(button.textContent).not.toMatch(/copied/i);
    expect(onCopy).not.toHaveBeenCalled();
  });
});

/**
 * Finding 8: `LOGOS` is a plain object literal indexed by `setup.id`, an
 * unvalidated string. `LOGOS["constructor"]` is `Object` — truthy, so the
 * card would destructure `.Logo` off it, get `undefined`, and React would
 * throw "type is invalid" while rendering. Not reachable today (ids come from
 * libi's own registry), which is precisely when it is cheap to close.
 */
describe("AgentSetupCard — an id is not a prototype key", () => {
  const odd = (id: string) => ({ ...getAgentSetup("codex")!, id });

  it("renders without a logo instead of throwing for a prototype-named id", () => {
    for (const id of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(() =>
        render(
          <AgentSetupCard
            setup={odd(id)}
            mode="sign-in"
            state={{ kind: "idle" }}
            surface="onboarding"
            onAction={noop}
            onRetry={noop}
            onCancel={noop}
          />,
        ),
      ).not.toThrow();
    }
  });
});
