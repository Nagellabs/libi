// scripts/analytics-smoke.ts
// Smoke-test the GA4 Measurement Protocol wiring end-to-end WITHOUT booting libi.
//
//   npx tsx scripts/analytics-smoke.ts
//
// It sends a handful of representative events twice:
//   1. to the GA4 /debug/mp/collect endpoint — which VALIDATES the payload + secret
//      and returns `validationMessages` (empty array = accepted). This is the
//      executable proof that the wiring is correct.
//   2. to the live /mp/collect endpoint with debug_mode:true — so the same events
//      appear in GA4 DebugView (Admin → DebugView) in realtime for a human to eyeball.
//
// The events are tagged with a recognizable user_id so they're easy to spot.
import { MEASUREMENT_ID, GA4_API_SECRET } from "../lib/analytics/config";

const USER_ID = `smoke-test-${Date.now()}`;

// Mirrors lib/analytics/server.ts#buildMpPayload (debug_mode always on here).
function payload(name: string, params: Record<string, unknown>) {
  return {
    client_id: USER_ID,
    user_id: USER_ID,
    events: [{ name, params: { ...params, debug_mode: true } }],
  };
}

const EVENTS: [string, Record<string, unknown>][] = [
  ["first_launch", {}],
  ["persona_selected", { persona: "agency" }],
  ["agent_connected", {}],
  ["tool_used", { tool_name: "libi.create_scene" }],
  ["page_view", { page_path: "/editor" }],
  ["export_completed", { backend: "ffmpeg-overlay", format: "mp4" }],
];

async function post(path: string, body: unknown): Promise<{ status: number; text: string }> {
  const url = `https://www.google-analytics.com/${path}?measurement_id=${encodeURIComponent(
    MEASUREMENT_ID,
  )}&api_secret=${encodeURIComponent(GA4_API_SECRET)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function main() {
  if (!GA4_API_SECRET) {
    console.error("✗ No api_secret configured (lib/analytics/config.ts). Aborting.");
    process.exit(1);
  }
  console.log(`measurement_id=${MEASUREMENT_ID}  user_id=${USER_ID}\n`);

  console.log("── 1. VALIDATION (/debug/mp/collect) ─────────────────────────");
  let allValid = true;
  for (const [name, params] of EVENTS) {
    const { status, text } = await post("debug/mp/collect", payload(name, params));
    let msgs: unknown[] = [];
    try {
      msgs = (JSON.parse(text).validationMessages as unknown[]) ?? [];
    } catch {
      /* non-JSON response */
    }
    const ok = status === 200 && msgs.length === 0;
    if (!ok) allValid = false;
    console.log(`  ${ok ? "✓" : "✗"} ${name.padEnd(18)} status=${status} ${msgs.length ? JSON.stringify(msgs) : "valid"}`);
  }

  console.log("\n── 2. LIVE w/ debug_mode (/mp/collect → DebugView) ───────────");
  for (const [name, params] of EVENTS) {
    const { status } = await post("mp/collect", payload(name, params));
    // The live endpoint returns 204 No Content on accept.
    console.log(`  ${status === 204 ? "✓" : "✗"} ${name.padEnd(18)} status=${status}`);
  }

  console.log(
    `\n${allValid ? "✓ All events validated." : "✗ Some events failed validation — see above."}`,
  );
  console.log(
    "\nCheck GA4 → Admin → DebugView (Property column). The events above should\n" +
      `appear within ~10–30s under debug device, tagged user_id=${USER_ID}.`,
  );
  process.exit(allValid ? 0 : 1);
}

void main();
