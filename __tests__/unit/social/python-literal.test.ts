/**
 * The Python-literal reader, fixture-tested against what a CAPTION actually
 * contains. Every case here is a payload a regex-substitution "parser" gets
 * wrong: an apostrophe (which flips Python's repr to double quotes), an
 * embedded double quote, an escaped quote, a newline, an em dash, emoji,
 * `None` / `True` / `False`, nesting, an empty dict, and floats.
 *
 * The strings on the left of each case are what Python itself prints for the
 * value on the right — checked by round-tripping the real thing, not by
 * writing what looked plausible.
 */
import { describe, it, expect } from "vitest";
import { parsePythonLiteral, PythonLiteralError } from "@/lib/social/python-literal";

describe("parsePythonLiteral — the shapes a caption arrives in", () => {
  it("reads a caption containing an apostrophe (repr switches to double quotes)", () => {
    expect(parsePythonLiteral(`{'content': "it's the desk setup that finally works"}`)).toEqual({
      content: "it's the desk setup that finally works",
    });
  });

  it("reads a caption containing a double quote", () => {
    expect(parsePythonLiteral(`{'content': 'she said "ship it" and left'}`)).toEqual({
      content: 'she said "ship it" and left',
    });
  });

  it("reads a caption containing BOTH quote styles, where repr has to escape one", () => {
    expect(parsePythonLiteral(`{'content': 'it\\'s a "big" day'}`)).toEqual({ content: 'it\'s a "big" day' });
    expect(parsePythonLiteral(`{'content': "it's a \\"big\\" day"}`)).toEqual({ content: 'it\'s a "big" day' });
  });

  it("reads None / True / False", () => {
    expect(parsePythonLiteral(`{'scheduledFor': None, 'isDraft': True, 'crosspostingEnabled': False}`)).toEqual({
      scheduledFor: null,
      isDraft: true,
      crosspostingEnabled: false,
    });
  });

  it("reads nested dicts and lists, and an empty dict", () => {
    expect(
      parsePythonLiteral(
        `{'post': {'_id': 'post_1', 'platforms': [{'platform': 'instagram', 'accountId': {'_id': 'acc_1'}}], 'metadata': {}}}`,
      ),
    ).toEqual({ post: { _id: "post_1", platforms: [{ platform: "instagram", accountId: { _id: "acc_1" } }], metadata: {} } });
    expect(parsePythonLiteral("[]")).toEqual([]);
    expect(parsePythonLiteral("{}")).toEqual({});
  });

  it("reads floats, negative numbers and ints", () => {
    expect(parsePythonLiteral(`{'engagementRate': 6.8, 'delta': -1.5, 'views': 4200, 'ratio': 1e-3}`)).toEqual({
      engagementRate: 6.8,
      delta: -1.5,
      views: 4200,
      ratio: 0.001,
    });
  });

  it("reads a unicode em dash, emoji and an escaped newline verbatim", () => {
    expect(parsePythonLiteral(`{'content': 'day one — the setup 🎬\\nday two'}`)).toEqual({
      content: "day one — the setup 🎬\nday two",
    });
    // \\u / \\x escapes, which a repr of a non-printable character produces.
    expect(parsePythonLiteral(`'\\u2014 \\x41'`)).toBe("— A");
  });

  it("reads a tuple as an array and a triple-quoted string", () => {
    expect(parsePythonLiteral(`('a', 'b')`)).toEqual(["a", "b"]);
    expect(parsePythonLiteral(`('solo',)`)).toEqual(["solo"]);
    expect(parsePythonLiteral(`'''line one\nline two'''`)).toBe("line one\nline two");
  });

  it("reads a whole live-shaped post answer", () => {
    const payload = `{'post': {'_id': '68cd', 'content': "libi's first post", 'title': None, 'mediaItems': [{'type': 'video', 'url': 'https://cdn.example/x.mp4'}], 'platforms': [{'platform': 'instagram', 'accountId': {'_id': 'acc_1', 'username': 'nagel'}, 'status': 'pending', 'scheduledFor': '2026-09-20T10:00:00.000Z'}], 'status': 'draft', 'tags': ['libi'], 'metadata': {'libi': {'pieceId': 'piece_1', 'requestId': 'r1'}}, 'crosspostingEnabled': True}}`;
    const parsed = parsePythonLiteral(payload) as { post: { content: string; metadata: { libi: { requestId: string } } } };
    expect(parsed.post.content).toBe("libi's first post");
    expect(parsed.post.metadata.libi.requestId).toBe("r1");
  });

  it("refuses what it cannot read rather than guessing", () => {
    // Prose is not a literal.
    expect(() => parsePythonLiteral("Found 2 connected account(s)")).toThrow(PythonLiteralError);
    // A constructor call is a value this parser must not invent.
    expect(() => parsePythonLiteral(`{'_id': ObjectId('68cd')}`)).toThrow(PythonLiteralError);
    // Half a payload is not a payload.
    expect(() => parsePythonLiteral(`{'a': 'b'`)).toThrow(PythonLiteralError);
    expect(() => parsePythonLiteral(`{'a': 'b'} trailing`)).toThrow(PythonLiteralError);
    expect(() => parsePythonLiteral(`{'a': 'unterminated`)).toThrow(PythonLiteralError);
  });

  it("never puts the source text into the error — a payload carries user content", () => {
    const err = (() => {
      try {
        parsePythonLiteral("the caption was 'my secret project name'");
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err?.message).not.toContain("my secret project name");
    expect(err?.message).toMatch(/offset \d+/);
  });
});
