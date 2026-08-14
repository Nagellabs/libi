/**
 * Narrow interfaces for the terminal session layer.
 *
 * TerminalManager depends on these instead of node-pty / ws types so unit
 * tests can inject fakes without loading the native addon or opening
 * sockets. `node-pty`'s IPty and `ws`'s WebSocket structurally satisfy
 * PtyLike / AttachedSocket for the subset we use.
 */

/** Hard cap on concurrent terminal sessions. Creation beyond this is
 *  rejected (409) — a running shell is never silently killed to make room.
 *  Lives here (not manager.ts) so client components can import it without
 *  pulling server-only deps (pino, @xterm/headless) into the bundle. */
export const MAX_TERMINAL_SESSIONS = 50;

export interface PtyLike {
  pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
  pause(): void;
  resume(): void;
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number }) => void): void;
}

export interface PtySpawnOpts {
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}

export type PtyFactory = (opts: PtySpawnOpts) => PtyLike;

/** The subset of `ws.WebSocket` the manager needs. */
export interface AttachedSocket {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  bufferedAmount: number;
  on(event: "message" | "close", cb: (arg?: unknown) => void): void;
}

export interface TerminalSessionMeta {
  id: string;
  title: string;
  /** Preset id from lib/terminal/presets.ts. */
  cliId: string;
  createdAt: number;
  status: "running" | "exited";
}

/** Client → server control messages (text frames). */
export type TerminalClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number };

/** Server → client control messages (text frames); output is binary frames. */
export type TerminalServerMessage =
  | { type: "snapshot"; data: string; cols: number; rows: number }
  | { type: "exit"; exitCode: number };
