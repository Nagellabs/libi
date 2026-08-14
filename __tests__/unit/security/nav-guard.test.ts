import { describe, it, expect } from "vitest";
import { navigationDecision, windowOpenExternal } from "@/electron/nav-guard";

/**
 * RC-G Task 18: the main window's navigation guard. In-window navigation is
 * locked to the app's own loopback origin; off-origin navigations are blocked
 * (and legitimate external http(s) links routed to the OS browser). window.open /
 * target="_blank" is always denied an Electron window.
 */
const APP_ORIGIN = "http://127.0.0.1:3456";

describe("navigationDecision (will-navigate guard)", () => {
  it("allows same-origin navigation (any path)", () => {
    expect(navigationDecision(`${APP_ORIGIN}/settings`, APP_ORIGIN)).toEqual({
      allow: true,
      openExternal: null,
    });
    expect(navigationDecision(`${APP_ORIGIN}/`, APP_ORIGIN).allow).toBe(true);
  });

  it("blocks an off-origin http(s) navigation and routes it externally", () => {
    expect(navigationDecision("https://evil.example/steal", APP_ORIGIN)).toEqual({
      allow: false,
      openExternal: "https://evil.example/steal",
    });
  });

  it("blocks a different-port loopback origin (not the app's own)", () => {
    const d = navigationDecision("http://127.0.0.1:9999/x", APP_ORIGIN);
    expect(d.allow).toBe(false);
    expect(d.openExternal).toBe("http://127.0.0.1:9999/x");
  });

  it("blocks localhost when the app loaded 127.0.0.1 (distinct origins)", () => {
    // The window loads http://127.0.0.1:<port>; localhost is a different origin.
    expect(navigationDecision(`http://localhost:3456/`, APP_ORIGIN).allow).toBe(false);
  });

  it("blocks non-http(s) schemes without opening them externally", () => {
    expect(navigationDecision("file:///etc/passwd", APP_ORIGIN)).toEqual({
      allow: false,
      openExternal: null,
    });
    expect(navigationDecision("javascript:alert(1)", APP_ORIGIN).openExternal).toBe(null);
  });

  it("blocks a malformed URL without crashing", () => {
    expect(navigationDecision("not a url", APP_ORIGIN)).toEqual({
      allow: false,
      openExternal: null,
    });
  });
});

describe("windowOpenExternal (setWindowOpenHandler)", () => {
  it("returns the URL for http(s) so it opens in the OS browser", () => {
    expect(windowOpenExternal("https://docs.example/guide")).toBe(
      "https://docs.example/guide",
    );
    expect(windowOpenExternal("http://example.com")).toBe("http://example.com");
  });

  it("returns null (deny outright) for non-http(s) and malformed", () => {
    expect(windowOpenExternal("file:///tmp/x")).toBe(null);
    expect(windowOpenExternal("javascript:alert(1)")).toBe(null);
    expect(windowOpenExternal("garbage")).toBe(null);
  });
});
