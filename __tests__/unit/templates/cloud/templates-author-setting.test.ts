import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, resetTestDb } from "@/__tests__/helpers/test-db";
import { getDb } from "@/lib/db/client";
import { settings } from "@/lib/db/schema";
import * as identity from "@/lib/templates/cloud/identity";
import { authorIdFromKey, generateCreatorKey } from "@/lib/templates/cloud/identity";
import { serverLogger } from "@/lib/logger";
import * as defaults from "@/lib/templates/cloud/default-nickname";
import { NICKNAME_PATTERN } from "@/lib/templates/cloud/constants";
import {
  getOrCreateTemplatesAuthor,
  getSettings,
  getTemplatesAuthor,
  getTemplatesAuthorForDisplay,
  importTemplatesAuthorKey,
  setTemplatesAuthor,
  setTemplatesAuthorNickname,
  updateSettings,
} from "@/lib/db/settings";

// Wrap generateCreatorKey so a test can run code in the window between
// getOrCreate's read and its write (standing in for a second process).
vi.mock("@/lib/templates/cloud/identity", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/templates/cloud/identity")>();
  return { ...real, generateCreatorKey: vi.fn(real.generateCreatorKey) };
});
// …and generateDefaultNickname, to run code between the backfill's read and its write.
vi.mock("@/lib/templates/cloud/default-nickname", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/templates/cloud/default-nickname")>();
  return { ...real, generateDefaultNickname: vi.fn(real.generateDefaultNickname) };
});

/** "<Adjective> <Animal> <NNNN>" — lib/templates/cloud/default-nickname.ts. */
const DEFAULT_NICKNAME = /^[A-Z][a-z]+ [A-Z][a-z]+ [1-9]\d{3}$/;
import { GET as GET_SETTINGS, PATCH as PATCH_SETTINGS } from "@/app/api/settings/route";

beforeEach(() => {
  createTestDb();
  vi.mocked(defaults.generateDefaultNickname).mockClear();
});
afterEach(() => {
  resetTestDb();
  vi.restoreAllMocks();
});

function writeRaw(value: string | null): void {
  getDb().insert(settings).values({ id: 1, templatesAuthor: value })
    .onConflictDoUpdate({ target: settings.id, set: { templatesAuthor: value } }).run();
}

describe("templatesAuthor setting", () => {
  it("is null until first use, then created once with a fresh key, a derived author id and a default nickname", () => {
    expect(getTemplatesAuthor()).toBeNull();
    const a = getOrCreateTemplatesAuthor();
    expect(a.key).toHaveLength(43);
    expect(a.authorId).toBe(authorIdFromKey(a.key));
    expect(a.nickname).toMatch(DEFAULT_NICKNAME);
    expect(getOrCreateTemplatesAuthor()).toEqual(a);
    expect(getTemplatesAuthor()).toEqual(a);
  });

  it("import replaces the key, recomputes the author id and resets the nickname to a fresh default", () => {
    const before = getOrCreateTemplatesAuthor();
    setTemplatesAuthor({ ...before, nickname: "old" });
    expect(getTemplatesAuthor()?.nickname).toBe("old");
    const key = generateCreatorKey();
    const after = importTemplatesAuthorKey(` ${key} `);
    expect(after.key).toBe(key);
    expect(after.authorId).toBe(authorIdFromKey(key));
    // The old key's nickname never follows a different key; the caller asks the site for this one's.
    expect(after.nickname).toMatch(DEFAULT_NICKNAME);
    expect(getTemplatesAuthor()).toEqual(after);
    expect(() => importTemplatesAuthorKey("nope")).toThrow(/not a creator key/);
    // A rejected import leaves the stored identity alone.
    expect(getTemplatesAuthor()).toEqual(after);
  });

  it("tolerates a malformed stored value by treating it as absent", () => {
    writeRaw(JSON.stringify({ key: "x", authorId: "y", nickname: null, createdAt: 1 }));
    expect(getTemplatesAuthor()).toBeNull();
    writeRaw("{not json");
    expect(getTemplatesAuthor()).toBeNull();
    writeRaw("null");
    expect(getTemplatesAuthor()).toBeNull();
    // …and getOrCreate replaces it with a fresh, valid identity.
    const fresh = getOrCreateTemplatesAuthor();
    expect(fresh.key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getTemplatesAuthor()).toEqual(fresh);
  });

  it("derives the author id from the key, never trusting a stored one", () => {
    const key = generateCreatorKey();
    setTemplatesAuthor({ key, authorId: "forged", nickname: "n", createdAt: 5 });
    expect(getTemplatesAuthor()).toEqual({ key, authorId: authorIdFromKey(key), nickname: "n", createdAt: 5 });
  });

  it("logs, without the value, when it mints over an unparseable stored value", () => {
    const warn = vi.spyOn(serverLogger, "warn");
    writeRaw("{half a key");
    getOrCreateTemplatesAuthor();
    const call = warn.mock.calls.find(([o]) => (o as { op?: string }).op === "author_unparseable");
    expect(call).toBeDefined();
    expect(JSON.stringify(call)).not.toContain("half a key");
    warn.mockClear();
    getOrCreateTemplatesAuthor(); // a usable value: nothing to report
    expect(warn.mock.calls.some(([o]) => (o as { op?: string }).op === "author_unparseable")).toBe(false);
  });

  it("the first mint loses to one that landed between its read and its write", () => {
    const winnerKey = generateCreatorKey();
    const winner = { key: winnerKey, authorId: authorIdFromKey(winnerKey), nickname: null, createdAt: 7 };
    vi.mocked(identity.generateCreatorKey).mockImplementationOnce(() => {
      writeRaw(JSON.stringify(winner)); // another process minted meanwhile
      return "L".repeat(43);
    });
    // Theirs wins — given its default nickname, since it had none.
    const got = getOrCreateTemplatesAuthor();
    expect(got).toEqual({ ...winner, nickname: expect.stringMatching(DEFAULT_NICKNAME) });
    expect(getTemplatesAuthor()).toEqual(got);
  });

  it("does not clobber the other settings columns", () => {
    updateSettings({ preferredAgent: "codex" });
    getOrCreateTemplatesAuthor();
    expect(getSettings().preferredAgent).toBe("codex");
    updateSettings({ panelChatSize: 33 });
    expect(getTemplatesAuthor()).not.toBeNull();
  });
});

describe("the default nickname", () => {
  const identityWith = (extra: Record<string, unknown>) => {
    const key = generateCreatorKey();
    writeRaw(JSON.stringify({ key, authorId: authorIdFromKey(key), createdAt: 3, ...extra }));
    return key;
  };

  it("a new identity is stored with one that the site's rule accepts", () => {
    const a = getOrCreateTemplatesAuthor();
    expect(a.nickname).toMatch(NICKNAME_PATTERN);
    const raw = getDb().select({ v: settings.templatesAuthor }).from(settings).where(eq(settings.id, 1)).get()?.v;
    expect(JSON.parse(raw!).nickname).toBe(a.nickname);
    expect(defaults.generateDefaultNickname).toHaveBeenCalledTimes(1);
  });

  it("an identity without one is given one lazily — on the first display read, then kept — and a plain read never writes", () => {
    for (const missing of [{ nickname: null }, { nickname: "" }, {}, { nickname: 42 }]) {
      const key = identityWith(missing);
      // The pure read reports what is stored.
      expect(getTemplatesAuthor()?.nickname).toBeNull();
      const shown = getTemplatesAuthorForDisplay();
      expect(shown?.key).toBe(key);
      expect(shown?.nickname).toMatch(DEFAULT_NICKNAME);
      expect(getTemplatesAuthor()).toEqual(shown);
      // Stable: read again, and through getOrCreate, it is the same name.
      expect(getTemplatesAuthorForDisplay()).toEqual(shown);
      expect(getOrCreateTemplatesAuthor()).toEqual(shown);
    }
  });

  it("getOrCreate backfills an existing identity too (the publish and nickname-edit paths)", () => {
    const key = identityWith({ nickname: null });
    const a = getOrCreateTemplatesAuthor();
    expect(a.key).toBe(key);
    expect(a.nickname).toMatch(DEFAULT_NICKNAME);
    expect(getTemplatesAuthor()).toEqual(a);
  });

  it("never replaces a nickname the user set", () => {
    identityWith({ nickname: "nadav" });
    expect(getTemplatesAuthorForDisplay()?.nickname).toBe("nadav");
    expect(getOrCreateTemplatesAuthor().nickname).toBe("nadav");
    expect(defaults.generateDefaultNickname).not.toHaveBeenCalled();
  });

  it("with no identity, the display read creates nothing", () => {
    expect(getTemplatesAuthorForDisplay()).toBeNull();
    expect(getTemplatesAuthor()).toBeNull();
  });

  it("loses to a nickname set between its read and its write: the user's stands", () => {
    const key = identityWith({ nickname: null });
    vi.mocked(defaults.generateDefaultNickname).mockImplementationOnce(() => {
      expect(setTemplatesAuthorNickname(key, "typed-meanwhile")).toBe(true);
      return "Brave Otter 4821";
    });
    expect(getTemplatesAuthorForDisplay()?.nickname).toBe("typed-meanwhile");
    expect(getTemplatesAuthor()?.nickname).toBe("typed-meanwhile");
  });

  it("never lands on a key imported between its read and its write", () => {
    identityWith({ nickname: null });
    let imported: ReturnType<typeof importTemplatesAuthorKey> | undefined;
    vi.mocked(defaults.generateDefaultNickname).mockImplementationOnce(() => {
      imported = importTemplatesAuthorKey(generateCreatorKey());
      return "Brave Otter 4821";
    });
    const shown = getTemplatesAuthorForDisplay();
    expect(imported).toBeDefined();
    // The identity that stands now, with its own default — not the one this backfill drew.
    expect(shown).toEqual(imported);
    expect(getTemplatesAuthor()).toEqual(imported);
    expect(imported!.nickname).not.toBe("Brave Otter 4821");
  });

  it("test mode's identity (row 2) gets its own default, and neither row touches the other", () => {
    const prod = getOrCreateTemplatesAuthor();
    vi.stubEnv("LIBI_TEST_MODE", "1");
    try {
      expect(getTemplatesAuthor()).toBeNull();
      const test = getOrCreateTemplatesAuthor();
      expect(test.key).not.toBe(prod.key);
      expect(test.nickname).toMatch(DEFAULT_NICKNAME);
      const row2 = getDb().select({ v: settings.templatesAuthor }).from(settings).where(eq(settings.id, 2)).get()?.v;
      expect(JSON.parse(row2!).nickname).toBe(test.nickname);
      // A row-2 identity without a nickname is backfilled in row 2 only.
      expect(setTemplatesAuthorNickname(test.key, null)).toBe(true);
      const shown = getTemplatesAuthorForDisplay();
      expect(shown?.key).toBe(test.key);
      expect(shown?.nickname).toMatch(DEFAULT_NICKNAME);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(getTemplatesAuthor()).toEqual(prod);
  });
});

describe("a stale identity cannot overwrite a newer key", () => {
  it("a nickname write that raced an import leaves the imported key in place", async () => {
    // A6/A10: read the identity, await the site, then save the nickname.
    const stale = getOrCreateTemplatesAuthor();
    const pending = (async () => {
      await Promise.resolve(); // the network round-trip
      return setTemplatesAuthorNickname(stale.key, "late");
    })();
    // The user pastes a key from another machine while that is in flight.
    const imported = importTemplatesAuthorKey(generateCreatorKey());
    expect(await pending).toBe(false);
    expect(getTemplatesAuthor()).toEqual(imported);

    expect(setTemplatesAuthorNickname(imported.key, "mine")).toBe(true);
    expect(getTemplatesAuthor()).toEqual({ ...imported, nickname: "mine" });
    expect(setTemplatesAuthorNickname(imported.key, null)).toBe(true);
    expect(getTemplatesAuthor()?.nickname).toBeNull();
  });

  it("a nickname write is a no-op when there is no identity, or it is unparseable", () => {
    const key = generateCreatorKey();
    expect(setTemplatesAuthorNickname(key, "n")).toBe(false);
    expect(getTemplatesAuthor()).toBeNull();
    writeRaw("{not json");
    expect(setTemplatesAuthorNickname(key, "n")).toBe(false);
  });

  it("with expectedNickname, writes only while the stored nickname is still the one read (null included)", () => {
    const { key } = getOrCreateTemplatesAuthor();
    expect(setTemplatesAuthorNickname(key, null)).toBe(true);
    expect(setTemplatesAuthorNickname(key, "from-site", { expectedNickname: "something-else" })).toBe(false);
    expect(getTemplatesAuthor()?.nickname).toBeNull();
    expect(setTemplatesAuthorNickname(key, "from-site", { expectedNickname: null })).toBe(true);
    expect(getTemplatesAuthor()?.nickname).toBe("from-site");
    expect(setTemplatesAuthorNickname(key, "again", { expectedNickname: null })).toBe(false);
    expect(setTemplatesAuthorNickname(key, "again", { expectedNickname: "from-site" })).toBe(true);
    expect(getTemplatesAuthor()?.nickname).toBe("again");
  });

  it("setTemplatesAuthor refuses to replace a different stored key unless told it is replacing it", () => {
    const stale = getOrCreateTemplatesAuthor();
    const imported = importTemplatesAuthorKey(generateCreatorKey());
    expect(() => setTemplatesAuthor({ ...stale, nickname: "late" })).toThrow(/different creator key/);
    expect(getTemplatesAuthor()).toEqual(imported);
    // Same key: an ordinary update.
    setTemplatesAuthor({ ...imported, nickname: "same" });
    expect(getTemplatesAuthor()?.nickname).toBe("same");
    // Explicit replacement (the import path).
    setTemplatesAuthor({ ...stale, nickname: null }, { replaceKey: true });
    expect(getTemplatesAuthor()?.key).toBe(stale.key);
  });

  it("setTemplatesAuthor rejects a value that is not a creator key", () => {
    expect(() => setTemplatesAuthor({ key: "x", authorId: "y", nickname: null, createdAt: 1 })).toThrow(
      /not a creator key/,
    );
    expect(getTemplatesAuthor()).toBeNull();
  });
});

describe("the creator key never leaves through the settings API", () => {
  it("GET /api/settings and PATCH /api/settings omit it", async () => {
    const { key, authorId } = getOrCreateTemplatesAuthor();
    const stored = getDb().select({ v: settings.templatesAuthor }).from(settings).where(eq(settings.id, 1)).all();
    expect(stored[0]?.v).toContain(key); // the secret really is in the row

    expect(Object.keys(getSettings())).not.toContain("templatesAuthor");

    const got = await (await GET_SETTINGS()).text();
    expect(got).not.toContain(key);
    expect(got).not.toContain(authorId);
    expect(got).not.toContain("templatesAuthor");

    const patched = await (
      await PATCH_SETTINGS(
        new Request("http://x/api/settings", {
          method: "PATCH",
          body: JSON.stringify({ panelChatSize: 41 }),
        }),
      )
    ).text();
    expect(patched).not.toContain(key);
    expect(patched).not.toContain(authorId);
  });

  it("PATCH /api/settings cannot overwrite it", async () => {
    const before = getOrCreateTemplatesAuthor();
    await PATCH_SETTINGS(
      new Request("http://x/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ templatesAuthor: JSON.stringify({ ...before, key: generateCreatorKey() }) }),
      }),
    );
    expect(getTemplatesAuthor()).toEqual(before);
  });
});
