// @vitest-environment jsdom
/**
 * The Electron splash's handling of a boot warning, run out of the shipped
 * `electron/splash.html` against a DOM.
 *
 * A boot whose MCP endpoint never came up carries on without libi's tools. The
 * splash has to say so, and the step's row must not end on the same green
 * tick a working step gets, even though the step then reports `done`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

type Listener = (event: unknown) => void;

function bootSplash(): (event: unknown) => void {
  const html = fs.readFileSync(path.join(process.cwd(), "electron/splash.html"), "utf-8");
  const doc = new DOMParser().parseFromString(html, "text/html");
  const script = doc.querySelector("body script")?.textContent;
  if (!script) throw new Error("no inline script in electron/splash.html");
  // Markup without the script (innerHTML never runs one), then the script
  // itself against a stubbed preload bridge.
  document.body.innerHTML = doc.body.innerHTML;
  let listener: Listener | null = null;
  (window as unknown as { splashAPI: unknown }).splashAPI = {
    onLifecycle: (cb: Listener) => {
      listener = cb;
      return () => {};
    },
    quit: () => {},
  };
  new Function(script)();
  return (event) => listener!(event);
}

const row = (step: string) => document.querySelector(`[data-key="b:${step}"]`) as HTMLElement | null;
const subtitle = () => document.getElementById("subtitle")?.textContent ?? "";

describe("electron/splash.html boot warning", () => {
  let emit: (event: unknown) => void;
  const message = "libi's tools are unavailable — open Agents → Libi MCP and press Restart.";

  beforeEach(() => {
    emit = bootSplash();
  });

  it("marks a warned step as a warning, keeps it through the step's done, and shows the message", () => {
    emit({ kind: "category-b-step", step: "mcp-http", status: "running" });
    emit({ kind: "warning", phase: "category-b", step: "mcp-http", message });
    emit({ kind: "category-b-step", step: "mcp-http", status: "done" });

    expect(row("mcp-http")?.className).toBe("item warning");
    expect(subtitle()).toBe(message);
    // Later progress does not paper over it.
    emit({ kind: "category-b-step", step: "agent-warm", status: "running" });
    expect(subtitle()).toBe(message);
    expect(document.body.classList.contains("is-failed")).toBe(false);
  });

  it("still ticks a step that did not warn", () => {
    emit({ kind: "category-b-step", step: "mcp-http", status: "running" });
    emit({ kind: "category-b-step", step: "mcp-http", status: "done" });
    expect(row("mcp-http")?.className).toBe("item done");
  });
});
