/** SHA-256 of a body's UTF-8 text as lowercase hex — the runtime's compiled-body
 *  cache key (spec §4.9). `crypto.subtle` exists in every browser the app runs in
 *  and in Node ≥ 20, so the same function serves the preview, the render page and
 *  the tests. */
export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
