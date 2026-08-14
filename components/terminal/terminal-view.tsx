"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { TERMINAL_INSERT_TEXT_EVENT } from "@/lib/onboarding/demo";
import "@xterm/xterm/css/xterm.css";

interface TerminalViewProps {
  terminalId: string;
  /** Fired when the server reports the shell exited. */
  onExited?: (exitCode: number) => void;
}

const RECONNECT_MAX_MS = 10_000;

/**
 * xterm palettes that track the app's light/dark theme (the `dark` class on
 * <html>, see components/layout/theme-toggle.tsx). The dark background is the
 * deep terminal black we've always used; the light background matches the
 * app's `--background` (#f7f4ef). xterm's default ANSI palette is tuned for
 * dark backgrounds — bright colors wash out on white — so the light theme
 * ships a readable ANSI set so colored CLI output (claude, codex) stays legible.
 */
const TERMINAL_BG = { dark: "#0c0c0e", light: "#f7f4ef" } as const;

const DARK_THEME: ITheme = {
  background: TERMINAL_BG.dark,
  foreground: "#e8e4dc",
  cursor: "#e8e4dc",
  cursorAccent: TERMINAL_BG.dark,
  selectionBackground: "#33373b",
};

const LIGHT_THEME: ITheme = {
  background: TERMINAL_BG.light,
  foreground: "#1f1d1a",
  cursor: "#1f1d1a",
  cursorAccent: TERMINAL_BG.light,
  selectionBackground: "#d8d2c4",
  black: "#1f1d1a",
  red: "#c0341d",
  green: "#3d7d3f",
  yellow: "#9a6700",
  blue: "#1c5fb0",
  magenta: "#8b2fb0",
  cyan: "#1a7a86",
  white: "#3a362e",
  brightBlack: "#8a8378",
  brightRed: "#d6492f",
  brightGreen: "#4d9a4f",
  brightYellow: "#b3850c",
  brightBlue: "#2a72c9",
  brightMagenta: "#a341c7",
  brightCyan: "#2295a3",
  brightWhite: "#1f1d1a",
};

/** Reads the app's current theme off the <html> `dark` class. */
function currentIsDark(): boolean {
  if (typeof document === "undefined") return true;
  return document.documentElement.classList.contains("dark");
}

/**
 * xterm's WebGL renderer dropped glyphs in verification even on a real
 * GPU (ANGLE Metal — word-final letters vanished from the atlas), so the
 * pixel-correct DOM renderer is the DEFAULT. One terminal at human
 * output rates doesn't need WebGL throughput. Power users can opt in
 * with `localStorage["libi:terminal-webgl"] = "1"` until the atlas issue
 * is understood.
 */
function webglOptedIn(): boolean {
  try {
    return localStorage.getItem("libi:terminal-webgl") === "1";
  } catch {
    return false;
  }
}

/**
 * xterm.js host for one terminal session. Imperative by nature — a single
 * effect owns the Terminal, the ResizeObserver, and the WebSocket; React
 * only provides the container div. Dynamically imported with `ssr: false`
 * (xterm touches DOM/WebGL at module scope).
 *
 * Protocol (see lib/terminal/types.ts): binary frames are raw PTY output;
 * text frames are JSON control messages. On (re)connect the server sends a
 * serialized snapshot first, so reattach restores the exact screen.
 */
export default function TerminalView({ terminalId, onExited }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const onExitedRef = useRef(onExited);
  onExitedRef.current = onExited;
  const [isDark, setIsDark] = useState(true);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const term = new Terminal({
      allowProposedApi: true,
      cursorBlink: true,
      fontSize: 13,
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", monospace',
      scrollback: 5000,
      theme: currentIsDark() ? DARK_THEME : LIGHT_THEME,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    term.open(container);
    // Stable hook for E2E tests / automation: lets a driver read the buffer
    // and call scroll APIs without reaching into xterm internals.
    (container as HTMLDivElement & { __xterm?: Terminal }).__xterm = term;
    // xterm 6.0.0's DOM renderer doesn't repaint when the viewport scrolls
    // (buffer.viewportY moves — wheel and scrollLines both work — but the
    // rows keep showing the old window; refresh() paints correctly). Force
    // a repaint on every scroll until upstream fixes it; the renderer
    // coalesces refreshes via rAF so this is cheap.
    term.onScroll(() => {
      term.refresh(0, term.rows - 1);
    });
    // DOM renderer by default (see webglOptedIn); WebGL is opt-in with a
    // silent fallback on context loss (xterm 6 dropped the canvas addon).
    if (webglOptedIn()) {
      import("@xterm/addon-webgl")
        .then(({ WebglAddon }) => {
          if (disposed) return;
          const webgl = new WebglAddon();
          webgl.onContextLoss(() => webgl.dispose());
          term.loadAddon(webgl);
        })
        .catch(() => {
          // DOM renderer it is.
        });
    }
    fit.fit();
    term.focus();

    const sendResize = () => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }),
        );
      }
    };
    const resizeObserver = new ResizeObserver(() => {
      fit.fit();
      sendResize();
    });
    resizeObserver.observe(container);

    term.onData((data) => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });

    const scheduleReconnect = () => {
      if (disposed) return;
      attempts++;
      const delay = Math.min(500 * 2 ** attempts, RECONNECT_MAX_MS);
      reconnectTimer = setTimeout(connect, delay);
    };

    async function connect(): Promise<void> {
      try {
        const res = await fetch("/api/terminal/ws-info");
        if (!res.ok) throw new Error(`ws-info ${res.status}`);
        const { port } = (await res.json()) as { port: number };
        if (disposed) return;

        const socket = new WebSocket(
          `ws://127.0.0.1:${port}/?session=${encodeURIComponent(terminalId)}`,
        );
        socket.binaryType = "arraybuffer";
        ws = socket;

        socket.onopen = () => {
          attempts = 0;
        };
        socket.onmessage = (ev: MessageEvent) => {
          if (typeof ev.data === "string") {
            let msg: { type: string; data?: string; cols?: number; rows?: number; exitCode?: number };
            try {
              msg = JSON.parse(ev.data);
            } catch {
              return;
            }
            if (msg.type === "snapshot") {
              // Replay at the server's dimensions for a faithful restore,
              // then adopt the local container size and tell the PTY.
              term.reset();
              if (msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
              term.write(msg.data ?? "", () => {
                fit.fit();
                sendResize();
              });
            } else if (msg.type === "exit") {
              onExitedRef.current?.(msg.exitCode ?? 0);
            }
          } else {
            term.write(new Uint8Array(ev.data as ArrayBuffer));
          }
        };
        socket.onclose = (ev: CloseEvent) => {
          if (disposed || ws !== socket) return;
          ws = null;
          // 1000 = clean shutdown (shell exited), 4404 = session gone —
          // both are terminal states, no reconnect.
          if (ev.code === 1000 || ev.code === 4404) return;
          scheduleReconnect();
        };
      } catch {
        scheduleReconnect();
      }
    }
    void connect();

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      resizeObserver.disconnect();
      ws?.close();
      term.dispose();
      termRef.current = null;
    };
  }, [terminalId]);

  // Let other UI (the onboarding demo chip) drop text into the live PTY. Uses
  // xterm's paste() so it routes through onData → the WebSocket input path, just
  // like a real paste. No trailing newline — the user reviews and presses Enter,
  // so we never auto-run something into a CLI that isn't at its prompt yet.
  useEffect(() => {
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      const term = termRef.current;
      if (!text || !term) return;
      term.paste(text);
      term.focus();
    };
    window.addEventListener(TERMINAL_INSERT_TEXT_EVENT, onInsert);
    return () => window.removeEventListener(TERMINAL_INSERT_TEXT_EVENT, onInsert);
  }, []);

  // Track the app's light/dark theme live. The toggle flips the `dark` class on
  // <html> (theme-toggle.tsx); a MutationObserver repaints the live xterm and
  // the surrounding container without recreating the session.
  useEffect(() => {
    const apply = () => {
      const dark = currentIsDark();
      setIsDark(dark);
      if (termRef.current) {
        termRef.current.options.theme = dark ? DARK_THEME : LIGHT_THEME;
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
    });
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      className="h-full w-full p-2"
      style={{ backgroundColor: isDark ? TERMINAL_BG.dark : TERMINAL_BG.light }}
    />
  );
}
