import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Two scenarios: (1) DB row has envVars with the key, (2) DB row empty but
// process.env.ELEVENLABS_API_KEY is set — getElevenLabsApiKey() must return
// the right value in each case.

const dbRowState: { envVars: string | null } = { envVars: null };

vi.mock("@/lib/db/client", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => ({
            all: () => [{ envVars: dbRowState.envVars }],
          }),
        }),
      }),
    }),
  }),
}));

import { getElevenLabsApiKey } from "@/lib/elevenlabs/transcribe";

describe("getElevenLabsApiKey: DB row → process.env fallback", () => {
  let priorEnv: string | undefined;

  beforeEach(() => {
    priorEnv = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    dbRowState.envVars = null;
  });

  afterEach(() => {
    if (priorEnv === undefined) delete process.env.ELEVENLABS_API_KEY;
    else process.env.ELEVENLABS_API_KEY = priorEnv;
  });

  it("returns the DB value when envVars is populated", async () => {
    dbRowState.envVars = JSON.stringify({ ELEVENLABS_API_KEY: "from-db" });
    process.env.ELEVENLABS_API_KEY = "from-env-should-lose";
    expect(await getElevenLabsApiKey()).toBe("from-db");
  });

  it("falls back to process.env when DB envVars is null", async () => {
    dbRowState.envVars = null;
    process.env.ELEVENLABS_API_KEY = "from-env";
    expect(await getElevenLabsApiKey()).toBe("from-env");
  });

  it("falls back to process.env when DB envVars JSON lacks the key", async () => {
    dbRowState.envVars = JSON.stringify({ SOME_OTHER_KEY: "x" });
    process.env.ELEVENLABS_API_KEY = "from-env";
    expect(await getElevenLabsApiKey()).toBe("from-env");
  });

  it("falls back to process.env when DB envVars JSON is malformed", async () => {
    dbRowState.envVars = "not json {{{";
    process.env.ELEVENLABS_API_KEY = "from-env";
    expect(await getElevenLabsApiKey()).toBe("from-env");
  });

  it("returns null when neither DB nor env has the key", async () => {
    dbRowState.envVars = JSON.stringify({});
    delete process.env.ELEVENLABS_API_KEY;
    expect(await getElevenLabsApiKey()).toBeNull();
  });

  it("trims whitespace", async () => {
    dbRowState.envVars = null;
    process.env.ELEVENLABS_API_KEY = "  spaced  ";
    expect(await getElevenLabsApiKey()).toBe("spaced");
  });

  it("treats whitespace-only env value as absent", async () => {
    dbRowState.envVars = null;
    process.env.ELEVENLABS_API_KEY = "   ";
    expect(await getElevenLabsApiKey()).toBeNull();
  });
});
