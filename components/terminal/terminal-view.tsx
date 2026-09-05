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
  // Shared with the insert-text effect below. `wsRef` mirrors whichever
  // socket the connect effect currently owns (null while connecting/between
  // attempts). `insertReadyRef` is true only once THIS connection's snapshot
  // has actually been applied — it flips back to false on every close, so a
  // fresh reconnect can't inherit "ready" from the socket it replaced and
  // race a paste against the `term.reset()` that's about to wipe it.
  const wsRef = useRef<WebSocket | null>(null);
  const insertReadyRef = useRef(false);
  // Text queued by the insert-text effect while the socket wasn't OPEN yet,
  // or was OPEN but hadn't replayed its snapshot. Flushed from the snapshot
  // handler below, immediately after `term.reset()` + the snapshot write —
  // never from `onopen`, which fires before the reset that would erase it.
  //
  // An ARRAY, not a single slot: this used to be a single `string | null`
  // that a second queued insert simply overwrote, silently losing the first
  // one — two file drops during a reconnect (or two demo-prompt injects)
  // landed only the second. Every insert queued before the flush is kept and
  // joined with a single space (the same separator `buildInsertText` uses
  // between paths) so consecutive drops land as distinct tokens instead of
  // abutting.
  const pendingInsertRef = useRef<string[]>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let disposed = false;
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
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(
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
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: "input", data }));
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
        wsRef.current = socket;

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
              // Only NOW — after the reset + replay above — is it safe to
              // land a queued insert. Doing it on `onopen` instead was tried
              // and reverted: the reset a few lines up would wipe it moments
              // later (see the module doc comment and
              // hooks/agents/use-run-remedy-in-terminal.ts).
              insertReadyRef.current = true;
              if (pendingInsertRef.current.length > 0) {
                const text = pendingInsertRef.current.join(" ");
                pendingInsertRef.current = [];
                term.paste(text);
                term.focus();
              }
            } else if (msg.type === "exit") {
              onExitedRef.current?.(msg.exitCode ?? 0);
            }
          } else {
            term.write(new Uint8Array(ev.data as ArrayBuffer));
          }
        };
        socket.onclose = (ev: CloseEvent) => {
          if (disposed || wsRef.current !== socket) return;
          wsRef.current = null;
          // The next socket (if any) starts a new attach and needs its own
          // snapshot before an insert is safe again — don't let "ready" from
          // this connection leak into the next one's pre-snapshot window.
          insertReadyRef.current = false;
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
      wsRef.current?.close();
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
    };
  }, [terminalId]);

  // Let other UI (the onboarding demo chip, a file drop) drop text into the
  // live PTY. Uses xterm's paste() so it routes through onData → the
  // WebSocket input path, just like a real paste. No trailing newline — the
  // user reviews and presses Enter, so we never auto-run something into a CLI
  // that isn't at its prompt yet.
  //
  // The socket isn't necessarily OPEN with a settled snapshot when this
  // fires: a sleep/resume can leave it CONNECTING for up to
  // RECONNECT_MAX_MS, and even once OPEN there's a window before the
  // attach snapshot has replayed. Pasting in either case used to be a
  // silent no-op (dropped by the `ws?.readyState === OPEN` guard downstream
  // in onData) or got wiped by the reset that snapshot replay does — see the
  // connect effect above. So anything that arrives before this connection is
  // both OPEN and past its snapshot gets queued in `pendingInsertRef` instead,
  // and is flushed from the snapshot handler once it's actually safe. If the
  // connection never establishes at all, the text just stays queued — better
  // than landing in a terminal nobody is attached to.
  useEffect(() => {
    const onInsert = (e: Event) => {
      const text = (e as CustomEvent<{ text?: string }>).detail?.text;
      const term = termRef.current;
      if (!text || !term) return;
      if (wsRef.current?.readyState === WebSocket.OPEN && insertReadyRef.current) {
        term.paste(text);
        term.focus();
      } else {
        // Accumulate — do not overwrite. A second insert queued before the
        // first is flushed (two drops in the same reconnect window) must not
        // silently discard the first one.
        pendingInsertRef.current.push(text);
      }
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
