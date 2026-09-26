/**
 * lib/templates/cloud/creator.ts — the application's input rules, and the
 * early "may this install publish?" check libi.publish_template runs before
 * preparing anything.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("@/lib/db/settings", () => ({ getTemplatesAuthor: vi.fn(), getOrCreateTemplatesAuthor: vi.fn() }));
vi.mock("@/lib/templates/cloud/client", () => ({ creatorStatus: vi.fn() }));
vi.mock("@/lib/logger", () => ({ serverLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import { getOrCreateTemplatesAuthor, getTemplatesAuthor } from "@/lib/db/settings";
import { creatorStatus } from "@/lib/templates/cloud/client";
import { serverLogger } from "@/lib/logger";
import { CREATOR_GATE_MESSAGES, checkCreatorApproved, parseCreatorApplicationInput } from "@/lib/templates/cloud/creator";

const KEY = "k".repeat(43);
const AUTHOR = { key: KEY, authorId: "a", nickname: "nadav", createdAt: 1 };

afterEach(() => {
  vi.resetAllMocks();
});

describe("parseCreatorApplicationInput", () => {
  it("trims and lowercases the email; the note is optional and trimmed", () => {
    expect(parseCreatorApplicationInput({ email: " A@B.co ", note: "  hooks " })).toEqual({ ok: true, email: "a@b.co", note: "hooks" });
    expect(parseCreatorApplicationInput({ email: "a@b.co" })).toEqual({ ok: true, email: "a@b.co", note: "" });
  });
  it("refuses a non-object, a bad or over-long email, a long note, control or bidi characters, and unknown keys", () => {
    for (const bad of [
      null,
      [],
      "a@b.co",
      {},
      { email: 5 },
      { email: "nope" },
      { email: "a@b" },
      { email: `${"x".repeat(250)}@b.co` },
      { email: "a@b.co", note: "x".repeat(501) },
      { email: "a@b.co", note: "a‮b" },
      { email: "a@b.co", note: "a\u0000b" },
      { email: "a@b.co", admin: true },
    ]) {
      expect(parseCreatorApplicationInput(bad), JSON.stringify(bad)).toMatchObject({ ok: false, error: expect.any(String) });
    }
  });
  it("takes a note of exactly 500 characters, and newlines in it", () => {
    expect(parseCreatorApplicationInput({ email: "a@b.co", note: "x".repeat(500) })).toMatchObject({ ok: true });
    expect(parseCreatorApplicationInput({ email: "a@b.co", note: "hooks\ncaptions" })).toMatchObject({ ok: true, note: "hooks\ncaptions" });
  });
});

describe("checkCreatorApproved", () => {
  it("no identity yet: one is made here, before anything else, and the site is asked about it", async () => {
    vi.mocked(getOrCreateTemplatesAuthor).mockReturnValue(AUTHOR);
    vi.mocked(creatorStatus).mockResolvedValue({ ok: true, status: "none" });
    expect(await checkCreatorApproved()).toEqual({ ok: false, status: "none", error: CREATOR_GATE_MESSAGES.none });
    expect(creatorStatus).toHaveBeenCalledWith(KEY);
  });
  it("an identity that can't be made falls back to the stored one; none at all is none, and the site is not asked", async () => {
    vi.mocked(getOrCreateTemplatesAuthor).mockImplementation(() => {
      throw new Error("changed meanwhile");
    });
    vi.mocked(getTemplatesAuthor).mockReturnValue(AUTHOR);
    vi.mocked(creatorStatus).mockResolvedValue({ ok: true, status: "approved" });
    expect(await checkCreatorApproved()).toEqual({ ok: true });
    vi.mocked(creatorStatus).mockClear();
    vi.mocked(getTemplatesAuthor).mockReturnValue(null);
    expect(await checkCreatorApproved()).toEqual({ ok: false, status: "none", error: CREATOR_GATE_MESSAGES.none });
    vi.mocked(getTemplatesAuthor).mockImplementation(() => {
      throw new Error("db");
    });
    expect(await checkCreatorApproved()).toEqual({ ok: false, status: "none", error: CREATOR_GATE_MESSAGES.none });
    expect(creatorStatus).not.toHaveBeenCalled();
  });
  // Review M1: a DB error on the identity used to read as a silent `none`.
  it("logs, with tag and op and never the error's own words, when the identity can't be made or read", async () => {
    vi.mocked(getOrCreateTemplatesAuthor).mockImplementation(() => {
      throw new Error(`INSERT failed for ${KEY}`);
    });
    vi.mocked(getTemplatesAuthor).mockImplementation(() => {
      throw new TypeError(`read failed for ${KEY}`);
    });
    expect(await checkCreatorApproved()).toMatchObject({ ok: false, status: "none" });
    expect(serverLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "templates-cloud", op: "creator_identity_unavailable", error: "Error" }), expect.any(String));
    expect(serverLogger.warn).toHaveBeenCalledWith(expect.objectContaining({ tag: "templates-cloud", op: "creator_identity_unreadable", error: "TypeError" }), expect.any(String));
    expect(JSON.stringify(vi.mocked(serverLogger.warn).mock.calls)).not.toContain(KEY);
  });
  it("approved passes; every other status gets its own words", async () => {
    vi.mocked(getOrCreateTemplatesAuthor).mockReturnValue(AUTHOR);
    vi.mocked(creatorStatus).mockResolvedValue({ ok: true, status: "approved" });
    expect(await checkCreatorApproved()).toEqual({ ok: true });
    expect(creatorStatus).toHaveBeenCalledWith(KEY);
    for (const status of ["none", "pending", "rejected"] as const) {
      vi.mocked(creatorStatus).mockResolvedValue({ ok: true, status });
      expect(await checkCreatorApproved()).toEqual({ ok: false, status, error: CREATOR_GATE_MESSAGES[status] });
    }
  });
  it("logs each invite-only refusal once, with tag, op and the status — never the key; approval logs nothing", async () => {
    vi.mocked(getOrCreateTemplatesAuthor).mockReturnValue(AUTHOR);
    vi.mocked(creatorStatus).mockResolvedValue({ ok: true, status: "approved" });
    await checkCreatorApproved();
    expect(serverLogger.info).not.toHaveBeenCalled();
    for (const status of ["none", "pending", "rejected"] as const) {
      vi.mocked(serverLogger.info).mockClear();
      vi.mocked(creatorStatus).mockResolvedValue({ ok: true, status });
      await checkCreatorApproved();
      expect(serverLogger.info).toHaveBeenCalledTimes(1);
      expect(vi.mocked(serverLogger.info).mock.calls[0][0]).toEqual({ tag: "templates-cloud", op: "creator_not_approved", status });
      expect(JSON.stringify(vi.mocked(serverLogger.info).mock.calls)).not.toContain(KEY);
    }
  });
  it("a site that doesn't answer is unknown — fail closed", async () => {
    vi.mocked(getOrCreateTemplatesAuthor).mockReturnValue(AUTHOR);
    vi.mocked(creatorStatus).mockResolvedValue({ ok: false, error: "socket hang up" });
    expect(await checkCreatorApproved()).toEqual({ ok: false, status: "unknown", error: CREATOR_GATE_MESSAGES.unknown });
  });
  it("every refusal says invite-only or nothing was prepared, and never names the key", () => {
    for (const m of Object.values(CREATOR_GATE_MESSAGES)) {
      expect(m).toMatch(/Nothing was prepared/);
      expect(m).not.toContain(KEY);
    }
    for (const k of ["none", "pending", "rejected"] as const) expect(CREATOR_GATE_MESSAGES[k]).toMatch(/invite-only/);
  });
});
