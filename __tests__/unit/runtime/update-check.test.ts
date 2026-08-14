import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
  checkForRuntimeUpdate,
  classifyUpdate,
  clearUpdateCheckCache,
  compareVersions,
  fetchLatestManifest,
  isNewer,
  latestManifestUrl,
  packumentUrl,
  FAILURE_TTL_MS,
  SUCCESS_TTL_MS,
} from "@/lib/runtime/update-check";
import {
  describeCurrentRuntime,
  type CurrentRuntime,
} from "@/lib/runtime/current-runtime";

const CURRENT: CurrentRuntime = {
  version: "0.1.0",
  shellApiVersion: 1,
  source: "bundled",
  shellApi: { min: 1, max: 1 },
  updatesSupported: true,
};

describe("compareVersions", () => {
  it("orders by numeric segment, not lexically", () => {
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.1.2", "0.1.10")).toBeLessThan(0);
  });

  it("sorts a prerelease below the release it precedes", () => {
    expect(compareVersions("1.2.0-rc.1", "1.2.0")).toBeLessThan(0);
    expect(isNewer("1.2.0-rc.1", "1.1.9")).toBe(true);
    // The case that matters: an rc must never present itself as an upgrade
    // over the release of the same triple.
    expect(isNewer("1.2.0-rc.1", "1.2.0")).toBe(false);
  });

  it("tolerates short / ragged versions", () => {
    expect(compareVersions("1", "1.0.0")).toBe(0);
    expect(compareVersions("2", "1.9.9")).toBeGreaterThan(0);
  });
});

describe("classifyUpdate", () => {
  it("reports unsupported without consulting anything else", () => {
    const s = classifyUpdate({
      currentVersion: "0.1.0",
      latest: { version: "9.9.9", shellApiVersion: 1 },
      shellApi: { min: 1, max: 1 },
      updatesSupported: false,
    });
    expect(s.state).toBe("unsupported");
  });

  it("is up-to-date when the registry has nothing newer", () => {
    expect(
      classifyUpdate({
        currentVersion: "0.1.0",
        latest: { version: "0.1.0", shellApiVersion: 1 },
        shellApi: { min: 1, max: 1 },
        updatesSupported: true,
      }).state,
    ).toBe("up-to-date");
  });

  // ── The Step-2 branch: compatible vs incompatible ──────────────────────
  it("offers a newer runtime INSIDE the shell's supported range", () => {
    const s = classifyUpdate({
      currentVersion: "0.1.0",
      latest: { version: "0.1.1", shellApiVersion: 1 },
      shellApi: { min: 1, max: 1 },
      updatesSupported: true,
    });
    expect(s.state).toBe("update-available");
    expect(s.latestVersion).toBe("0.1.1");
  });

  it("refuses to offer a runtime ABOVE the shell's range", () => {
    // This is the whole point of the contract: installing it would download
    // ~1GB, land it on disk, and have the loader reject it at next launch
    // (`api-too-new`), leaving the user "updated" to nothing.
    const s = classifyUpdate({
      currentVersion: "0.1.0",
      latest: { version: "0.2.0", shellApiVersion: 2 },
      shellApi: { min: 1, max: 1 },
      updatesSupported: true,
    });
    expect(s.state).toBe("shell-update-required");
  });

  it("refuses a runtime BELOW the shell's range too", () => {
    const s = classifyUpdate({
      currentVersion: "0.1.0",
      latest: { version: "0.2.0", shellApiVersion: 1 },
      shellApi: { min: 2, max: 3 },
      updatesSupported: true,
    });
    expect(s.state).toBe("shell-update-required");
  });

  it("accepts anything inside a WIDER shell range", () => {
    const s = classifyUpdate({
      currentVersion: "0.1.0",
      latest: { version: "0.2.0", shellApiVersion: 2 },
      shellApi: { min: 1, max: 3 },
      updatesSupported: true,
    });
    expect(s.state).toBe("update-available");
  });

  it("stays silent when compatibility is indeterminate", () => {
    // A published version with no declared shellApiVersion, or a shell whose
    // range we never learned. Both are malformed states — offering an
    // unverifiable install would be worse than saying nothing.
    expect(
      classifyUpdate({
        currentVersion: "0.1.0",
        latest: { version: "0.2.0", shellApiVersion: null },
        shellApi: { min: 1, max: 1 },
        updatesSupported: true,
      }).state,
    ).toBe("unknown");
    expect(
      classifyUpdate({
        currentVersion: "0.1.0",
        latest: { version: "0.2.0", shellApiVersion: 2 },
        shellApi: null,
        updatesSupported: true,
      }).state,
    ).toBe("unknown");
  });

  it("is unknown when the registry could not be reached", () => {
    const s = classifyUpdate({
      currentVersion: "0.1.0",
      latest: null,
      shellApi: { min: 1, max: 1 },
      updatesSupported: true,
    });
    expect(s.state).toBe("unknown");
    expect(s.latestVersion).toBeNull();
  });
});

describe("registry URLs", () => {
  it("percent-encodes the scope separator and tolerates a missing slash", () => {
    expect(latestManifestUrl("http://127.0.0.1:4873/")).toBe(
      "http://127.0.0.1:4873/@nagellabs%2Flibi/latest",
    );
    expect(packumentUrl("http://127.0.0.1:4873")).toBe(
      "http://127.0.0.1:4873/@nagellabs%2Flibi",
    );
  });
});

describe("fetchLatestManifest", () => {
  it("reads version + shellApiVersion from the /latest manifest", async () => {
    const fetchImpl = (async (url: string) => {
      expect(String(url)).toContain("/latest");
      return {
        ok: true,
        json: async () => ({ version: "0.1.1", libi: { shellApiVersion: 1 } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(
      fetchLatestManifest({ registryUrl: "http://127.0.0.1:4873/", fetchImpl }),
    ).resolves.toEqual({ version: "0.1.1", shellApiVersion: 1 });
  });

  it("falls back to the full packument when /latest is not served", async () => {
    const fetchImpl = (async (url: string) => {
      if (String(url).endsWith("/latest")) {
        return { ok: false, status: 404 } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({
          "dist-tags": { latest: "0.2.0" },
          versions: { "0.2.0": { version: "0.2.0", libi: { shellApiVersion: 2 } } },
        }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await expect(
      fetchLatestManifest({ registryUrl: "http://127.0.0.1:4873/", fetchImpl }),
    ).resolves.toEqual({ version: "0.2.0", shellApiVersion: 2 });
  });

  // OFFLINE — the rule the whole module exists for.
  it("returns null (never throws) when the network is down", async () => {
    const fetchImpl = (async () => {
      throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
    }) as unknown as typeof fetch;

    await expect(
      fetchLatestManifest({ registryUrl: "https://registry.npmjs.org/", fetchImpl }),
    ).resolves.toBeNull();
  });

  it("returns null on malformed JSON rather than propagating", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("Unexpected token <");
      },
    })) as unknown as typeof fetch;

    await expect(
      fetchLatestManifest({ registryUrl: "https://registry.npmjs.org/", fetchImpl }),
    ).resolves.toBeNull();
  });
});

describe("checkForRuntimeUpdate", () => {
  beforeEach(() => clearUpdateCheckCache());
  afterEach(() => clearUpdateCheckCache());

  it("never touches the network when updates are unsupported", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return { ok: true, json: async () => ({ version: "9.9.9" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const s = await checkForRuntimeUpdate({
      current: { ...CURRENT, updatesSupported: false },
      fetchImpl,
    });
    expect(s.state).toBe("unsupported");
    expect(calls).toBe(0);
  });

  it("caches a success and serves it without re-fetching", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ version: "0.1.1", libi: { shellApiVersion: 1 } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const a = await checkForRuntimeUpdate({ current: CURRENT, fetchImpl, now: 1000 });
    expect(a.state).toBe("update-available");
    const b = await checkForRuntimeUpdate({
      current: CURRENT,
      fetchImpl,
      now: 1000 + SUCCESS_TTL_MS - 1,
    });
    expect(b).toEqual(a);
    expect(calls).toBe(1);

    // …and re-checks once the TTL is past.
    await checkForRuntimeUpdate({
      current: CURRENT,
      fetchImpl,
      now: 1000 + SUCCESS_TTL_MS + 1,
    });
    expect(calls).toBe(2);
  });

  it("caches a FAILURE briefly so an offline machine is not hammered", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    const a = await checkForRuntimeUpdate({ current: CURRENT, fetchImpl, now: 0 });
    expect(a.state).toBe("unknown");
    await checkForRuntimeUpdate({ current: CURRENT, fetchImpl, now: FAILURE_TTL_MS - 1 });
    // Two `get` attempts inside ONE check (/latest + packument fallback), then
    // the cache serves the second call.
    expect(calls).toBe(2);
    await checkForRuntimeUpdate({ current: CURRENT, fetchImpl, now: FAILURE_TTL_MS + 1 });
    expect(calls).toBe(4);
  });

  it("`force` bypasses the cache", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ version: "0.1.0", libi: { shellApiVersion: 1 } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await checkForRuntimeUpdate({ current: CURRENT, fetchImpl, now: 0 });
    await checkForRuntimeUpdate({ current: CURRENT, fetchImpl, now: 1, force: true });
    expect(calls).toBe(2);
  });
});

describe("describeCurrentRuntime", () => {
  it("takes the shell's published API range verbatim", () => {
    const c = describeCurrentRuntime({
      env: {
        LIBI_RUNTIME_VERSION: "0.1.1",
        LIBI_RUNTIME_SOURCE: "user",
        LIBI_SHELL_API_MIN: "1",
        LIBI_SHELL_API_MAX: "3",
      },
      cwd: process.cwd(),
      isPackaged: true,
    });
    expect(c.version).toBe("0.1.1");
    expect(c.source).toBe("user");
    expect(c.shellApi).toEqual({ min: 1, max: 3 });
    expect(c.updatesSupported).toBe(true);
  });

  it("falls back to [own, own] when the shell published no range", () => {
    // An older shell driving a newer runtime. The conservative answer: the
    // shell demonstrably accepts THIS integer and we know nothing else.
    const c = describeCurrentRuntime({ env: {}, cwd: process.cwd(), isPackaged: true });
    expect(c.shellApiVersion).toBe(1); // repo package.json#libi.shellApiVersion
    expect(c.shellApi).toEqual({ min: 1, max: 1 });
  });

  it("reports a dev checkout as unsupported", () => {
    const c = describeCurrentRuntime({ env: {}, cwd: process.cwd(), isPackaged: false });
    expect(c.updatesSupported).toBe(false);
    expect(c.source).toBe("dev");
  });

  it("survives an unreadable manifest", () => {
    const c = describeCurrentRuntime({
      env: {},
      cwd: "/definitely/not/a/real/path",
      isPackaged: true,
    });
    expect(c.version).toBeNull();
    expect(c.shellApi).toBeNull();
  });
});
