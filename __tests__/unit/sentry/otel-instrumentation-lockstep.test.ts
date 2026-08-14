import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// `@opentelemetry/instrumentation`, `import-in-the-middle`, and
// `require-in-the-middle` were promoted from undeclared transitives to
// direct `dependencies` in package.json to pin their hoisted top-level
// location — `next.config.ts`'s `serverExternalPackages` require()s them by
// their REAL name at runtime, so Next must externalise (and npm must hoist)
// the SAME copy `@sentry/node` itself loads. See next.config.ts's
// `serverExternalPackages` comment for the "packaged app dies at boot with
// Cannot find module require-in-the-middle-<hash>" failure this prevents.
//
// The trap: `@opentelemetry/instrumentation` is a 0.x package, so a caret
// range pins an exact MINOR (`^0.214.0` == `>=0.214.0 <0.215.0`). Today our
// declared range matches `@sentry/node`'s own requirement exactly. If
// `@sentry/node` is ever bumped to a version that requires a NEWER
// `@opentelemetry/instrumentation` minor (e.g. `^0.215.0`) without our pin
// moving too, npm can no longer hoist a single shared copy: it hoists OUR
// pinned 0.214.x to the top level (satisfying our declared range) and nests
// Sentry's required 0.215.x under `@sentry/node/node_modules/` (satisfying
// Sentry's). Next then externalises against the top-level copy while Sentry
// loads the nested one — two OpenTelemetry instrumentation instances, two
// `import-in-the-middle` hook registries — and `PACKAGES_MISSING`
// (lib/install/next-externals.ts) does NOT fire, because the package IS
// present at top level. Silent, exactly the failure shape the externals
// mechanism exists to prevent.
//
// This test reads the ACTUALLY INSTALLED `@sentry/node` (and, one hop down
// the coupling chain, the actually installed `@opentelemetry/instrumentation`
// it pulls in) and asserts our declared ranges in package.json still
// overlap what they require. It fails loudly — not the two undeclared
// transitives silently going missing — the moment a future bump diverges,
// which is the whole point: a comment alone doesn't fail a build.

const ROOT = path.resolve(__dirname, "..", "..", "..");

interface PackageManifest {
  version?: string;
  dependencies?: Record<string, string>;
}

function readManifest(pkgName: string): PackageManifest {
  const manifestPath = path.join(
    ROOT,
    "node_modules",
    ...pkgName.split("/"),
    "package.json",
  );
  return JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
}

function ourDeclaredRange(pkgName: string): string {
  const ourPkg: PackageManifest = JSON.parse(
    fs.readFileSync(path.join(ROOT, "package.json"), "utf-8"),
  );
  const range = ourPkg.dependencies?.[pkgName];
  if (!range) {
    throw new Error(
      `${pkgName} is no longer a direct dependency in package.json — ` +
        "if that's intentional, this lockstep test should be removed too.",
    );
  }
  return range;
}

/** Minimal caret-range ([^]X.Y.Z) → [min, maxExclusive] parser. All ranges
 *  involved here (our pins + upstream's own declared deps) are plain caret
 *  ranges, so a tiny purpose-built parser avoids pulling in an undeclared
 *  `semver` dependency just for a test. */
function parseCaretRange(range: string): {
  min: [number, number, number];
  maxExclusive: [number, number, number];
} {
  const m = /^\^(\d+)\.(\d+)\.(\d+)/.exec(range.trim());
  if (!m) {
    throw new Error(
      `expected a caret range (^X.Y.Z), got "${range}" — update parseCaretRange if the upstream range shape changed`,
    );
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = Number(m[3]);
  // npm caret semantics: for major>=1, ^M.m.p allows up to (but excluding)
  // (M+1).0.0. For 0.x, a bump is only "compatible" within the same minor
  // (^0.m.p → <0.(m+1).0), and for 0.0.x within the same patch.
  let maxExclusive: [number, number, number];
  if (major > 0) maxExclusive = [major + 1, 0, 0];
  else if (minor > 0) maxExclusive = [0, minor + 1, 0];
  else maxExclusive = [0, 0, patch + 1];
  return { min: [major, minor, patch], maxExclusive };
}

function compareVersions(
  a: [number, number, number],
  b: [number, number, number],
): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** True iff the two caret ranges admit at least one common version — the
 *  condition npm needs to be able to hoist a single shared copy. */
function rangesOverlap(rangeA: string, rangeB: string): boolean {
  const a = parseCaretRange(rangeA);
  const b = parseCaretRange(rangeB);
  return (
    compareVersions(a.min, b.maxExclusive) < 0 &&
    compareVersions(b.min, a.maxExclusive) < 0
  );
}

describe("@sentry/node <-> promoted OpenTelemetry direct-deps lockstep", () => {
  it("our @opentelemetry/instrumentation range overlaps what the installed @sentry/node actually requires", () => {
    const sentryNode = readManifest("@sentry/node");
    const sentryRequiresOtelInstrumentation =
      sentryNode.dependencies?.["@opentelemetry/instrumentation"];
    expect(
      sentryRequiresOtelInstrumentation,
      "@sentry/node no longer declares a dependency on @opentelemetry/instrumentation — re-check whether the direct dep + this test are still needed",
    ).toBeTruthy();

    const ourRange = ourDeclaredRange("@opentelemetry/instrumentation");

    expect(
      rangesOverlap(ourRange, sentryRequiresOtelInstrumentation!),
      `package.json pins @opentelemetry/instrumentation to "${ourRange}", but the installed ` +
        `@sentry/node@${sentryNode.version} requires "${sentryRequiresOtelInstrumentation}" — these no ` +
        "longer overlap, so npm can't hoist one shared copy: our pin wins the top-level slot and " +
        "Sentry's requirement gets nested under @sentry/node/node_modules/, splitting the OpenTelemetry " +
        "instrumentation + import-in-the-middle hook registry in two, silently (PACKAGES_MISSING won't " +
        "fire — the package IS present at top level). Bump the @opentelemetry/instrumentation dependency " +
        "range in package.json to track @sentry/node's requirement (see " +
        "__tests__/unit/sentry/otel-instrumentation-lockstep.test.ts).",
    ).toBe(true);
  });

  it("our import-in-the-middle range overlaps what the installed @opentelemetry/instrumentation actually requires", () => {
    const otelInstrumentation = readManifest("@opentelemetry/instrumentation");
    const otelRequiresIitm =
      otelInstrumentation.dependencies?.["import-in-the-middle"];
    expect(
      otelRequiresIitm,
      "@opentelemetry/instrumentation no longer declares a dependency on import-in-the-middle — re-check whether the direct dep + this test are still needed",
    ).toBeTruthy();

    const ourRange = ourDeclaredRange("import-in-the-middle");

    expect(
      rangesOverlap(ourRange, otelRequiresIitm!),
      `package.json pins import-in-the-middle to "${ourRange}", but the installed ` +
        `@opentelemetry/instrumentation@${otelInstrumentation.version} (itself pulled in by @sentry/node) ` +
        `requires "${otelRequiresIitm}" — these no longer overlap. See the message in the ` +
        "@opentelemetry/instrumentation lockstep test for why that splits the hook registry silently.",
    ).toBe(true);
  });

  it("our require-in-the-middle range overlaps what the installed @opentelemetry/instrumentation actually requires", () => {
    const otelInstrumentation = readManifest("@opentelemetry/instrumentation");
    const otelRequiresRitm =
      otelInstrumentation.dependencies?.["require-in-the-middle"];
    expect(
      otelRequiresRitm,
      "@opentelemetry/instrumentation no longer declares a dependency on require-in-the-middle — re-check whether the direct dep + this test are still needed",
    ).toBeTruthy();

    const ourRange = ourDeclaredRange("require-in-the-middle");

    expect(
      rangesOverlap(ourRange, otelRequiresRitm!),
      `package.json pins require-in-the-middle to "${ourRange}", but the installed ` +
        `@opentelemetry/instrumentation@${otelInstrumentation.version} (itself pulled in by @sentry/node) ` +
        `requires "${otelRequiresRitm}" — these no longer overlap. See the message in the ` +
        "@opentelemetry/instrumentation lockstep test for why that splits the hook registry silently.",
    ).toBe(true);
  });
});
