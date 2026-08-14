import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { mcpServers } from "@/lib/db/schema/sqlite";
import { readFalApiKey } from "@/lib/analysis/script-providers/fal-api-key";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

vi.mock("@/lib/db/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/db/client")>("@/lib/db/client");
  return { ...actual, getDb: () => db };
});

describe("readFalApiKey", () => {
  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => resetTestDb());

  it("returns null when fal-ai row is missing", async () => {
    expect(await readFalApiKey()).toBeNull();
  });

  it("returns null when env_vars has no FAL_KEY", async () => {
    db.insert(mcpServers).values({
      id: "fal-ai",
      name: "fal-ai",
      type: "stdio",
      envVars: JSON.stringify({ SOMETHING_ELSE: "x" }),
    }).run();
    expect(await readFalApiKey()).toBeNull();
  });

  it("returns the key when set", async () => {
    db.insert(mcpServers).values({
      id: "fal-ai",
      name: "fal-ai",
      type: "stdio",
      envVars: JSON.stringify({ FAL_KEY: "key-abc" }),
    }).run();
    expect(await readFalApiKey()).toBe("key-abc");
  });

  it("returns null when FAL_KEY is an empty string", async () => {
    db.insert(mcpServers).values({
      id: "fal-ai",
      name: "fal-ai",
      type: "stdio",
      envVars: JSON.stringify({ FAL_KEY: "" }),
    }).run();
    expect(await readFalApiKey()).toBeNull();
  });

  it("returns null when env_vars is malformed JSON", async () => {
    db.insert(mcpServers).values({
      id: "fal-ai",
      name: "fal-ai",
      type: "stdio",
      envVars: "not-valid-json",
    }).run();
    expect(await readFalApiKey()).toBeNull();
  });
});
