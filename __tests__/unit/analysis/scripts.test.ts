import { describe, expect, it } from "vitest";
import { buildScriptKind, findLatestScriptStep, parseScriptStep, toMs } from "@/lib/analysis/scripts";
import type { AnalysisStep, Script } from "@/lib/analysis/types";

function makeScript(): Script {
  return {
    schema_version: "script_v1",
    duration: 10,
    overall_style: "cinematic",
    shots: [
      { index: 0, start: 0, end: 5, description: "shot a" },
      { index: 1, start: 5, end: 10, description: "shot b" },
    ],
    music: { present: false },
    provider: {
      name: "fal-video-understanding",
      model: "gemini-2.5-pro",
      generatedAt: "2026-05-25T00:00:00.000Z",
    },
  };
}

function makeStep(kind: string, content: string | null): AnalysisStep {
  return {
    id: "step-1",
    fileId: "file-1",
    pieceId: null,
    kind: kind as AnalysisStep["kind"],
    status: "ready",
    content,
    metadata: null,
    errorMessage: null,
    sourceModifiedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("buildScriptKind", () => {
  it("formats provider and model", () => {
    expect(buildScriptKind("fal-video-understanding", "gemini-2.5-pro")).toBe(
      "script:fal-video-understanding:gemini-2.5-pro",
    );
  });

  it("uses 'default' when modelId is empty", () => {
    expect(buildScriptKind("foo", "")).toBe("script:foo:default");
  });
});

describe("parseScriptStep", () => {
  it("returns null for non-script kinds", () => {
    const step = makeStep("summary", JSON.stringify(makeScript()));
    expect(parseScriptStep(step)).toBeNull();
  });

  it("returns null when content is null", () => {
    const step = makeStep("script:fal:gemini-2.5-pro", null);
    expect(parseScriptStep(step)).toBeNull();
  });

  it("returns null when content is not valid JSON", () => {
    const step = makeStep("script:fal:gemini-2.5-pro", "not json");
    expect(parseScriptStep(step)).toBeNull();
  });

  it("returns null when content fails schema validation", () => {
    const step = makeStep("script:fal:gemini-2.5-pro", JSON.stringify({ schema_version: "wrong" }));
    expect(parseScriptStep(step)).toBeNull();
  });

  it("parses a valid script step", () => {
    const script = makeScript();
    const step = makeStep("script:fal-video-understanding:gemini-2.5-pro", JSON.stringify(script));
    const result = parseScriptStep(step);
    expect(result).not.toBeNull();
    expect(result!.providerId).toBe("fal-video-understanding");
    expect(result!.modelId).toBe("gemini-2.5-pro");
    expect(result!.script.shots).toHaveLength(2);
  });

  it("returns null for malformed kind with extra colons", () => {
    // Provider and model ids cannot contain colons; if the kind has 4+ parts, fail safe.
    const step = makeStep("script:fal:a:b:c", JSON.stringify(makeScript()));
    const result = parseScriptStep(step);
    expect(result).toBeNull();
  });
});

function step(overrides: Partial<AnalysisStep>): AnalysisStep {
  return {
    id: overrides.id ?? "s",
    fileId: "f",
    pieceId: null,
    kind: overrides.kind ?? "summary",
    status: "ready",
    content: overrides.content ?? null,
    metadata: null,
    errorMessage: null,
    sourceModifiedAt: null,
    createdAt: overrides.createdAt ?? new Date(0),
    updatedAt: overrides.createdAt ?? new Date(0),
  } as AnalysisStep;
}

describe("findLatestScriptStep", () => {
  it("returns undefined when no script rows exist", () => {
    const steps = [
      step({ kind: "summary" }),
      step({ kind: "frames" }),
    ];
    expect(findLatestScriptStep(steps)).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(findLatestScriptStep(undefined)).toBeUndefined();
  });

  it("returns the only script row when exactly one exists", () => {
    const only = step({
      id: "a",
      kind: "script:fal-video-understanding:gemini-2.5-pro",
      content: "{}",
      createdAt: new Date("2026-05-25T10:00:00Z"),
    });
    expect(findLatestScriptStep([step({ kind: "summary" }), only])?.id).toBe("a");
  });

  it("returns the newest script row when multiple exist", () => {
    const older = step({
      id: "old",
      kind: "script:fal-video-understanding:gemini-2.5-pro",
      content: "{}",
      createdAt: new Date("2026-05-20T10:00:00Z"),
    });
    const newer = step({
      id: "new",
      kind: "script:fal-video-understanding:gemini-2.5-flash",
      content: "{}",
      createdAt: new Date("2026-05-25T10:00:00Z"),
    });
    expect(findLatestScriptStep([older, newer])?.id).toBe("new");
    expect(findLatestScriptStep([newer, older])?.id).toBe("new");
  });

  it("handles string-serialized createdAt (post-JSON-parse case)", () => {
    // After JSON.parse, Date fields arrive as ISO strings — React Query never
    // re-hydrates them. Verify the shared helper still picks the newest correctly.
    const older = {
      ...step({ kind: "script:foo:bar", content: "{}" }),
      createdAt: "2026-05-20T00:00:00Z" as unknown as Date,
    };
    const newer = {
      ...step({ kind: "script:foo:bar", content: "{}" }),
      createdAt: "2026-05-25T00:00:00Z" as unknown as Date,
    };
    expect(findLatestScriptStep([older, newer])?.createdAt).toBe(newer.createdAt);
    expect(findLatestScriptStep([newer, older])?.createdAt).toBe(newer.createdAt);
  });
});

describe("toMs", () => {
  it("returns 0 for null/undefined", () => {
    expect(toMs(null)).toBe(0);
    expect(toMs(undefined)).toBe(0);
  });

  it("coerces a Date object", () => {
    const d = new Date("2026-05-25T00:00:00Z");
    expect(toMs(d)).toBe(d.getTime());
  });

  it("coerces an ISO string", () => {
    expect(toMs("2026-05-25T00:00:00Z")).toBe(new Date("2026-05-25T00:00:00Z").getTime());
  });
});
