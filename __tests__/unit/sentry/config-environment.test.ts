import { describe, it, expect, afterEach, vi } from "vitest";

// SENTRY_ENVIRONMENT decides which Sentry environment a report is filed under.
// It is a module-load-time const off `process.env`, so each case needs a fresh
// import with the environment already in place — the same dynamic-import dance
// __tests__/unit/sentry/scrub.test.ts documents.
//
// What these pin: a dev checkout must NOT file its traffic as `production`.
// Sentry is off in a checkout by default, so the only reason it is ever on
// there is someone testing — and before this, that test traffic landed beside
// real users' reports with nothing but a hand-passed override to separate them.

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

async function environmentWith(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return (await import("@/lib/sentry/config")).SENTRY_ENVIRONMENT;
}

describe("SENTRY_ENVIRONMENT", () => {
  it("reports production for a production build", async () => {
    // npx @nagellabs/libi, the packaged desktop app, and anything
    // scripts/next-build-release.js produces.
    const env = await environmentWith({
      NODE_ENV: "production",
      NEXT_PUBLIC_LIBI_SENTRY_ENV: undefined,
    });

    expect(env).toBe("production");
  });

  it("reports qa for a dev build, not production", async () => {
    // `npm run dev:electron`, a contributor checkout, dev-sentry-live.js.
    // This is the whole point of the change: no hand-passed override needed.
    const env = await environmentWith({
      NODE_ENV: "development",
      NEXT_PUBLIC_LIBI_SENTRY_ENV: undefined,
    });

    expect(env).toBe("qa");
  });

  it("never reports production for anything that is not a production build", async () => {
    // Guards the shape of the check: an inverted or truthy-only condition would
    // let `test` (and any future NODE_ENV) through as production.
    for (const nodeEnv of ["development", "test", ""]) {
      const env = await environmentWith({
        NODE_ENV: nodeEnv,
        NEXT_PUBLIC_LIBI_SENTRY_ENV: undefined,
      });
      expect(env, `NODE_ENV=${JSON.stringify(nodeEnv)}`).toBe("qa");
    }
  });

  it("lets an explicit override win over the build", async () => {
    // A staging project, or a one-off run that wants its own tag.
    const overProd = await environmentWith({
      NODE_ENV: "production",
      NEXT_PUBLIC_LIBI_SENTRY_ENV: "staging",
    });
    const overDev = await environmentWith({
      NODE_ENV: "development",
      NEXT_PUBLIC_LIBI_SENTRY_ENV: "staging",
    });

    expect(overProd).toBe("staging");
    expect(overDev).toBe("staging");
  });
});
