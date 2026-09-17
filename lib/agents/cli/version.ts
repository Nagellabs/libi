/** `--version` parsing. `claude --version` prints `2.1.245 (Claude Code)`; `codex --version` prints `codex-cli 0.153.4`. */
export function parseFirstSemver(text: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

export function satisfiesMinimum(version: string, minimum: string): boolean {
  return compareSemver(version, minimum) >= 0;
}
