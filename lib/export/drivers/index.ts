import type { RenderDriver } from "./types";

let cached: RenderDriver | null = null;

export function pickDriver(): RenderDriver {
  if (cached) return cached;
  if (isElectronMainProcess()) {
    cached = loadElectronDriver();
  } else {
    cached = loadPlaywrightDriver();
  }
  return cached;
}

export function __resetDriverForTests() {
  cached = null;
}

function isElectronMainProcess(): boolean {
  return typeof process !== "undefined" && !!process.versions?.electron;
}

function loadElectronDriver(): RenderDriver {
  // Intentional require() (see CLAUDE.md "Code Style"): the Electron driver imports
  // `electron`, which throws at load time outside an Electron process. Lazy-load so
  // the Playwright path never touches Electron bindings and vice versa.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("./electron") as { electronDriver: RenderDriver };
  return mod.electronDriver;
}

function loadPlaywrightDriver(): RenderDriver {
  // Intentional require() (see CLAUDE.md "Code Style"): symmetric with
  // loadElectronDriver — keeps the driver module out of the import graph
  // until the runtime actually selects it. The Playwright driver itself
  // dynamic-imports `playwright-core` inside getBrowser(), so nothing heavy
  // loads at module-eval time either way.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("./playwright") as { playwrightDriver: RenderDriver };
  return mod.playwrightDriver;
}

export type { RenderDriver } from "./types";
