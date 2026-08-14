import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetScriptProviderRegistryForTests,
  getScriptProvider,
  listScriptProviders,
  registerScriptProvider,
} from "@/lib/analysis/script-providers/registry";
import type { ScriptProvider } from "@/lib/analysis/script-providers/types";

function makeProvider(id: string, configured = true): ScriptProvider {
  return {
    id,
    displayName: `Provider ${id}`,
    defaultModelId: "default-model",
    async isConfigured() {
      return configured;
    },
    async generate() {
      return { text: "{}", providerName: id };
    },
  };
}

describe("script-provider registry", () => {
  beforeEach(() => __resetScriptProviderRegistryForTests());

  it("registers and retrieves by id", () => {
    const p = makeProvider("a");
    registerScriptProvider(p);
    expect(getScriptProvider("a")).toBe(p);
  });

  it("throws on duplicate id", () => {
    registerScriptProvider(makeProvider("a"));
    expect(() => registerScriptProvider(makeProvider("a"))).toThrow(/already registered/);
  });

  it("getScriptProvider without id returns the first registered provider", () => {
    const first = makeProvider("first");
    const second = makeProvider("second");
    registerScriptProvider(first);
    registerScriptProvider(second);
    expect(getScriptProvider()).toBe(first);
  });

  it("throws when no providers are registered", () => {
    expect(() => getScriptProvider()).toThrow(/no script providers/i);
  });

  it("throws when an unknown id is requested", () => {
    registerScriptProvider(makeProvider("a"));
    expect(() => getScriptProvider("does-not-exist")).toThrow(/unknown script provider/i);
  });

  it("listScriptProviders returns providers in registration order", () => {
    const a = makeProvider("a");
    const b = makeProvider("b");
    registerScriptProvider(a);
    registerScriptProvider(b);
    expect(listScriptProviders().map((p) => p.id)).toEqual(["a", "b"]);
  });
});
