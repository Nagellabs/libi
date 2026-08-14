import { describe, it, expect } from "vitest";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import { extractModelOption, modelDisplayLabel } from "@/lib/sessions/model-option";

function modelSelect(
  currentValue: string,
  options: Array<{ value: string; name: string; description?: string }>,
): SessionConfigOption {
  return {
    type: "select",
    id: "model",
    name: "Model",
    currentValue,
    options,
  } as unknown as SessionConfigOption;
}

describe("extractModelOption", () => {
  it("returns null for null/undefined/empty config options", () => {
    expect(extractModelOption(null)).toBeNull();
    expect(extractModelOption(undefined)).toBeNull();
    expect(extractModelOption([])).toBeNull();
  });

  it("returns null when there is no option with id 'model'", () => {
    const opts = [
      { type: "select", id: "mode", name: "Approval", currentValue: "auto", options: [] },
    ] as unknown as SessionConfigOption[];
    expect(extractModelOption(opts)).toBeNull();
  });

  it("extracts currentModelId and a flat, order-preserving model list", () => {
    const opts = [
      modelSelect("claude-opus-4-8", [
        { value: "claude-opus-4-8", name: "Opus 4.8", description: "Most capable" },
        { value: "claude-sonnet-4-6", name: "Sonnet 4.6" },
      ]),
    ];
    expect(extractModelOption(opts)).toEqual({
      currentModelId: "claude-opus-4-8",
      availableModels: [
        { id: "claude-opus-4-8", name: "Opus 4.8", description: "Most capable" },
        { id: "claude-sonnet-4-6", name: "Sonnet 4.6", description: undefined },
      ],
    });
  });

  it("flattens grouped select options", () => {
    const grouped = {
      type: "select",
      id: "model",
      name: "Model",
      currentValue: "gpt-5",
      options: [
        { group: "frontier", name: "Frontier", options: [{ value: "gpt-5", name: "GPT-5" }] },
        { group: "fast", name: "Fast", options: [{ value: "gpt-5-mini", name: "GPT-5 mini" }] },
      ],
    } as unknown as SessionConfigOption;
    expect(extractModelOption([grouped])).toEqual({
      currentModelId: "gpt-5",
      availableModels: [
        { id: "gpt-5", name: "GPT-5", description: undefined },
        { id: "gpt-5-mini", name: "GPT-5 mini", description: undefined },
      ],
    });
  });

  it("returns null when the 'model' option is not a select (e.g. boolean)", () => {
    const opts = [
      { type: "boolean", id: "model", name: "Model", currentValue: true },
    ] as unknown as SessionConfigOption[];
    expect(extractModelOption(opts)).toBeNull();
  });
});

describe("modelDisplayLabel", () => {
  it("extracts the versioned name from the leading description token", () => {
    // Real claude-agent-acp 0.44 descriptions.
    expect(
      modelDisplayLabel({
        id: "default",
        name: "Default (recommended)",
        description: "Opus 4.8 with 1M context · Best for everyday, complex tasks",
      }),
    ).toBe("Opus 4.8");
    expect(
      modelDisplayLabel({
        id: "claude-fable-5[1m]",
        name: "Fable",
        description: "Fable 5 · Most capable for your hardest and longest-running tasks",
      }),
    ).toBe("Fable 5");
    expect(
      modelDisplayLabel({ id: "sonnet", name: "Sonnet", description: "Sonnet 4.6 · Efficient for routine tasks" }),
    ).toBe("Sonnet 4.6");
    expect(
      modelDisplayLabel({ id: "haiku", name: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" }),
    ).toBe("Haiku 4.5");
  });

  it("falls back to name when the description has no version prefix", () => {
    expect(
      modelDisplayLabel({ id: "x", name: "Custom Model", description: "A bespoke model" }),
    ).toBe("Custom Model");
  });

  it("falls back to name when there is no description, then to id", () => {
    expect(modelDisplayLabel({ id: "x", name: "Just A Name" })).toBe("Just A Name");
    expect(modelDisplayLabel({ id: "raw-id", name: "" })).toBe("raw-id");
  });

  it("prettifies codex model-family ids that have no versioned description", () => {
    // codex-acp advertises no leading "<Name> <version>" description token, so
    // the description-prefix path can't fire — the id must be prettified.
    expect(modelDisplayLabel({ id: "gpt-5-codex", name: "" })).toBe("GPT-5 Codex");
    expect(modelDisplayLabel({ id: "gpt-5.5", name: "" })).toBe("GPT-5.5");
    expect(modelDisplayLabel({ id: "o4-mini", name: "" })).toBe("o4-mini");
  });

  it("prefers a good name over the id for codex families", () => {
    expect(modelDisplayLabel({ id: "gpt-5.5", name: "GPT-5.5" })).toBe("GPT-5.5");
  });
});
