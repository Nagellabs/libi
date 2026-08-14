// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";

/**
 * The hook subscribes to the effects registry itself (useSyncExternalStore):
 * when the post-commit effect registers a fresh set, the registry notifies and
 * the host re-renders — replacing the old setState-in-effect version bump.
 */

const mockUseCustomEffects = vi.fn();
vi.mock("@/lib/queries/effects-catalog", () => ({
  useCustomEffects: () => mockUseCustomEffects(),
}));

// compileCustomPayload needs real effect packages; stub it to a deterministic
// def so the test exercises the REGISTRATION + subscription plumbing.
const fakeDef = {
  meta: {
    id: "custom.wobble",
    name: "Wobble",
    family: "animation",
    phases: ["in"],
    supports: ["text"],
  },
  compose: () => ({}),
};
vi.mock("@/lib/effects/hydrate-custom-client", () => ({
  compileCustomPayload: (custom: unknown) =>
    custom
      ? { defs: [fakeDef], customIds: new Set(["custom.wobble"]) }
      : { defs: [], customIds: new Set() },
}));

import { useRegisterCustomEffects } from "@/hooks/preview/use-register-custom-effects";
import { clearCustomEffects, listEffects } from "@/lib/effects/registry";

afterEach(() => {
  clearCustomEffects();
});

describe("useRegisterCustomEffects", () => {
  it("is not ready before the query resolves and registers nothing", () => {
    mockUseCustomEffects.mockReturnValue({ data: undefined, isSuccess: false });
    const { result } = renderHook(() => useRegisterCustomEffects());
    expect(result.current.ready).toBe(false);
    expect(result.current.count).toBe(0);
    expect(listEffects().some((e) => e.meta.id === "custom.wobble")).toBe(false);
  });

  it("registers the compiled defs once the query succeeds", async () => {
    mockUseCustomEffects.mockReturnValue({
      data: { custom: [{ id: "custom.wobble" }] },
      isSuccess: true,
    });
    const { result } = renderHook(() => useRegisterCustomEffects());
    expect(result.current.ready).toBe(true);
    expect(result.current.count).toBe(1);
    expect(result.current.customIds.has("custom.wobble")).toBe(true);
    await waitFor(() =>
      expect(listEffects().some((e) => e.meta.id === "custom.wobble")).toBe(true),
    );
  });

  it("re-renders subscribers when the registry mutates externally", async () => {
    mockUseCustomEffects.mockReturnValue({
      data: { custom: [{ id: "custom.wobble" }] },
      isSuccess: true,
    });
    let renders = 0;
    renderHook(() => {
      renders++;
      return useRegisterCustomEffects();
    });
    const before = renders;
    act(() => {
      clearCustomEffects(); // notifies the registry's subscribers
    });
    await waitFor(() => expect(renders).toBeGreaterThan(before));
  });
});
