import { describe, it, expect } from "vitest";
import { firstLaunchHref, safeReturnPath } from "@/lib/onboarding/return-to";

/**
 * A user who never answered the persona question is sent to the Agents tab from
 * wherever they were going, and brought back there once they answer. The place
 * to come back to travels in the URL, so it is only ever followed as a path on
 * this app — never to another site.
 */
const ORIGIN = "http://127.0.0.1:3456";

function expectRefused(values: Array<string | null>) {
  for (const value of values) {
    expect(safeReturnPath(value, ORIGIN), JSON.stringify(value)).toBeNull();
  }
}

describe("firstLaunchHref", () => {
  it("the plain editor a launch opens has nothing to come back to", () => {
    expect(firstLaunchHref({ pathname: "/editor", search: "" })).toBe("/agents?tab=agents");
  });

  it("a deep link is carried along, whole", () => {
    expect(firstLaunchHref({ pathname: "/editor", search: "?piece=p1&session=s2" })).toBe(
      "/agents?tab=agents&returnTo=%2Feditor%3Fpiece%3Dp1%26session%3Ds2",
    );
  });

  it("what it carries is a place safeReturnPath goes back to, unchanged", () => {
    const href = firstLaunchHref({ pathname: "/editor", search: "?piece=p1&session=s2" });
    const carried = new URLSearchParams(href.slice(href.indexOf("?"))).get("returnTo");
    expect(safeReturnPath(carried, ORIGIN)).toBe("/editor?piece=p1&session=s2");
  });
});

describe("safeReturnPath", () => {
  it("keeps a path on this app, query and all", () => {
    expect(safeReturnPath("/editor?piece=p1&session=s2", ORIGIN)).toBe("/editor?piece=p1&session=s2");
    expect(safeReturnPath("/characters", ORIGIN)).toBe("/characters");
    expect(safeReturnPath("/editor?piece=abc", ORIGIN)).toBe("/editor?piece=abc");
    expect(safeReturnPath("/agents?tab=providers#x", ORIGIN)).toBe("/agents?tab=providers#x");
    expect(safeReturnPath("/", ORIGIN)).toBe("/");
    // An encoded slash inside the query is part of a value, not of the path.
    expect(safeReturnPath("/editor?piece=a%2Fb", ORIGIN)).toBe("/editor?piece=a%2Fb");
  });

  it("refuses anything that would leave the app's own pages", () => {
    expectRefused([
      null,
      "",
      "editor",
      "https://evil.example/editor",
      "//evil.example/editor",
      "/\\evil.example/editor",
      "/\t/evil.example/editor",
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,hi",
      "http:/evil.example",
      " /editor",
      "\t//evil.example",
      "/api/pieces",
      "/api",
    ]);
  });

  // Browsers resolve a path that starts `//` or `/\` against another host. These
  // start with a single slash, and only take that shape once dot-segments resolve.
  it("refuses a path that only turns into another host once its dot-segments are resolved", () => {
    expectRefused([
      "/.//evil.example/x",
      "/a/..//evil.example",
      "/..//evil.example",
      "/./\\evil.example",
      "/%2e%2e//evil.example",
      "/%2E//evil.example",
      "/.%2e//evil.example",
      "/.\t//evil.example",
    ]);
  });

  it("refuses encoded slashes and backslashes in the path, however many times they are encoded", () => {
    expectRefused([
      "/%2F%2Fevil.example",
      "/%2f%2fevil.example",
      "/%2F/evil.example",
      "/%5Cevil.example",
      "/%5cevil.example",
      "/%252F%252Fevil.example",
      "/%25252F%25252Fevil.example",
      "/a/..%2F%2Fevil.example",
      "/.%2F%2Fevil.example",
      "/%2e%2e%2F%2Fevil.example",
      "/%2561pi/pieces",
      "/%E0%A4%A", // malformed encoding
      // An encoded `?` or `#` hides the encoded slashes after it from a naive
      // decoded check: decoding stops at the raw `?`/`#`, but the fully-decoded
      // path turns into `/?//evil.example` / `/#//evil.example`.
      "/%3F%2F%2Fevil.example",
      "/%23%2F%2Fevil.example",
      // Double-encoded: still decodes down to the same shape.
      "/%253F%252F%252Fevil.example",
    ]);
  });

  it("refuses backslashes, whitespace and control characters anywhere in the value", () => {
    expectRefused([
      "/editor\\evil.example",
      "/editor?piece=a\\b",
      "/ /evil.example",
      "/editor evil",
      "/\n/evil.example",
      "/\r/evil.example",
      "/\u0000/evil.example",
      "/\u007f/evil.example",
      "/\u00a0/evil.example",
      "/\u2028/evil.example",
      "/\u200b/evil.example",
      "/\u3000/evil.example",
      "/\ufeff/evil.example",
      "/%09/evil.example",
      "/%00/evil.example",
      "/%20/evil.example",
    ]);
  });
});
