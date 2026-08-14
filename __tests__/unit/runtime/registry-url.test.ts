/**
 * `lib/runtime/registry-url.ts` — the single decision point for which npm
 * registry libi talks to at runtime.
 *
 * The load-bearing property is the GATE, not the string: the
 * `LIBI_REGISTRY_URL` override exists so Tasks 8/9 can be verified against a
 * local Verdaccio (`scripts/local-registry/`), and it must be structurally
 * incapable of taking effect in a dev checkout, in a worktree, or in an
 * unpackaged run. Every negative case below is a case where a leaked env var
 * would otherwise redirect where executable code is fetched from.
 */
import { describe, it, expect } from "vitest";

import {
  PUBLIC_NPM_REGISTRY,
  REGISTRY_URL_ENV,
  WORKTREE_ENV,
  normalizeRegistryUrl,
  registryOverrideAllowed,
  describeRegistryUrl,
  resolveRegistryUrl,
  detectIsPackaged,
} from "@/lib/runtime/registry-url";

const LOCAL = "http://localhost:4873/";

describe("normalizeRegistryUrl", () => {
  it("accepts a loopback http registry and keeps the trailing slash", () => {
    expect(normalizeRegistryUrl(LOCAL)).toEqual({ url: LOCAL });
  });

  it("adds the trailing slash npm's own config uses", () => {
    expect(normalizeRegistryUrl("http://127.0.0.1:4873")).toEqual({
      url: "http://127.0.0.1:4873/",
    });
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeRegistryUrl("  http://localhost:4873/  ")).toEqual({
      url: LOCAL,
    });
  });

  it("accepts https on any host (private corporate registries)", () => {
    expect(normalizeRegistryUrl("https://npm.internal.example.com/")).toEqual({
      url: "https://npm.internal.example.com/",
    });
  });

  it("strips query and hash — a registry root carries neither, and joining onto one corrupts every path", () => {
    expect(normalizeRegistryUrl("https://r.example.com/root?a=1#frag")).toEqual({
      url: "https://r.example.com/root/",
    });
  });

  it.each([undefined, null, "", "   "])("rejects empty input %p", (raw) => {
    expect(normalizeRegistryUrl(raw)).toEqual({ rejected: "invalid-url" });
  });

  it("rejects a non-URL", () => {
    expect(normalizeRegistryUrl("localhost:4873")).toEqual({
      rejected: "unsupported-protocol",
    });
    expect(normalizeRegistryUrl("not a url")).toEqual({ rejected: "invalid-url" });
  });

  it.each(["file:///tmp/registry", "ftp://example.com/", "javascript:alert(1)"])(
    "rejects unsupported protocol %s",
    (raw) => {
      expect(normalizeRegistryUrl(raw)).toEqual({
        rejected: "unsupported-protocol",
      });
    },
  );

  it("rejects plaintext http to a remote host — a downgrade decides where code comes from", () => {
    expect(normalizeRegistryUrl("http://registry.evil.example.com/")).toEqual({
      rejected: "insecure-remote",
    });
  });

  it("rejects inline credentials", () => {
    expect(normalizeRegistryUrl("https://user:pass@npm.example.com/")).toEqual({
      rejected: "embedded-credentials",
    });
  });
});

describe("registryOverrideAllowed", () => {
  it("is true only when packaged and not a worktree", () => {
    expect(registryOverrideAllowed({ isPackaged: true, env: {} })).toBe(true);
  });

  it("is false when unpackaged (dev checkout / npx)", () => {
    expect(registryOverrideAllowed({ isPackaged: false, env: {} })).toBe(false);
  });

  it("is false in a worktree even when packaged", () => {
    expect(
      registryOverrideAllowed({
        isPackaged: true,
        env: { [WORKTREE_ENV]: "my-worktree" },
      }),
    ).toBe(false);
  });

  it("treats a blank worktree name as absent", () => {
    expect(
      registryOverrideAllowed({ isPackaged: true, env: { [WORKTREE_ENV]: "  " } }),
    ).toBe(true);
  });
});

describe("describeRegistryUrl", () => {
  it("defaults to the public registry with no override", () => {
    expect(describeRegistryUrl({ isPackaged: true, env: {} })).toEqual({
      url: PUBLIC_NPM_REGISTRY,
      source: "public",
    });
  });

  it("applies a valid override when packaged and not a worktree", () => {
    expect(
      describeRegistryUrl({
        isPackaged: true,
        env: { [REGISTRY_URL_ENV]: LOCAL },
      }),
    ).toEqual({ url: LOCAL, source: "override" });
  });

  it("IGNORES the override in an unpackaged run and says why", () => {
    expect(
      describeRegistryUrl({
        isPackaged: false,
        env: { [REGISTRY_URL_ENV]: LOCAL },
      }),
    ).toEqual({
      url: PUBLIC_NPM_REGISTRY,
      source: "public",
      rejected: "not-packaged",
    });
  });

  it("IGNORES the override in a worktree and says why", () => {
    expect(
      describeRegistryUrl({
        isPackaged: true,
        env: { [REGISTRY_URL_ENV]: LOCAL, [WORKTREE_ENV]: "wt" },
      }),
    ).toEqual({
      url: PUBLIC_NPM_REGISTRY,
      source: "public",
      rejected: "worktree",
    });
  });

  it("falls back to public — never throws — on a malformed override", () => {
    expect(
      describeRegistryUrl({
        isPackaged: true,
        env: { [REGISTRY_URL_ENV]: "file:///tmp/x" },
      }),
    ).toEqual({
      url: PUBLIC_NPM_REGISTRY,
      source: "public",
      rejected: "unsupported-protocol",
    });
  });

  it("reads only the env passed in — nothing user-writable at runtime", () => {
    // No settings file, no ~/.libi read: swapping the injected env is the only
    // way to change the answer.
    const withOverride = describeRegistryUrl({
      isPackaged: true,
      env: { [REGISTRY_URL_ENV]: LOCAL },
    });
    const without = describeRegistryUrl({ isPackaged: true, env: {} });
    expect(withOverride.url).toBe(LOCAL);
    expect(without.url).toBe(PUBLIC_NPM_REGISTRY);
  });
});

describe("resolveRegistryUrl", () => {
  it("is the url half of describeRegistryUrl", () => {
    expect(resolveRegistryUrl({ isPackaged: true, env: {} })).toBe(
      PUBLIC_NPM_REGISTRY,
    );
    expect(
      resolveRegistryUrl({ isPackaged: true, env: { [REGISTRY_URL_ENV]: LOCAL } }),
    ).toBe(LOCAL);
    expect(
      resolveRegistryUrl({ isPackaged: false, env: { [REGISTRY_URL_ENV]: LOCAL } }),
    ).toBe(PUBLIC_NPM_REGISTRY);
  });

  it("defaults env to process.env when none is injected", () => {
    // vitest runs under plain Node, so this is the unpackaged path: the
    // ambient env cannot produce an override no matter what it holds.
    expect(resolveRegistryUrl({ isPackaged: false })).toBe(PUBLIC_NPM_REGISTRY);
  });
});

describe("detectIsPackaged", () => {
  it("is false outside Electron (npx / plain node / the test runner itself)", () => {
    expect(process.versions.electron).toBeUndefined();
    expect(detectIsPackaged()).toBe(false);
  });
});
