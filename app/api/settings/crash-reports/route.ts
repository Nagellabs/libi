import { NextResponse } from "next/server";
import { z } from "zod/v3";
import { getCrashReportSettings, setCrashReportSettings } from "@/lib/db/settings";
import { setCrashReportChoice } from "@/lib/sentry/enabled";
import { SENTRY_KILL_SWITCHED } from "@/lib/sentry/config";

export async function GET(): Promise<Response> {
  const s = getCrashReportSettings();
  // `killSwitched` is the RUNTIME view of `LIBI_SENTRY_DISABLED`, which the
  // browser bundle cannot see for itself: Next inlines `NEXT_PUBLIC_*` at
  // build time, so a prebuilt renderer carries the build machine's value and
  // the launcher's mirror never reaches it. The server reads the env live, so
  // reporting it here is what makes `LIBI_SENTRY_DISABLED=1 npx
  // @nagellabs/libi` silence the renderer too — the behaviour the published
  // privacy policy (Nagellabs/libi-site) promises for command-line installs.
  //
  // It is NOT folded into `choice`: the switch is an operator override, and
  // writing it into the stored preference would corrupt the user's actual
  // decision the moment the switch is lifted.
  return NextResponse.json({
    choice: s.choice,
    decidedAt: s.decidedAt,
    killSwitched: SENTRY_KILL_SWITCHED,
  });
}

// "unset" is deliberately excluded — it's the internal not-asked-yet state;
// a client PUT is by definition a user decision, so only "on"/"off" are
// accepted here.
const bodySchema = z.object({ choice: z.enum(["on", "off"]) });

export async function PUT(req: Request): Promise<Response> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const next = setCrashReportSettings({ choice: parsed.data.choice, decidedAt: Date.now() });

  // Requirement: move the live in-process gate immediately. The Sentry
  // beforeSend/beforeSendLog hooks (lib/sentry/scrub.ts) and the gated
  // transport (lib/sentry/gated-transport.ts) read a module-level cache
  // seeded once at boot — without this call, the DB would say "off" but the
  // running server would keep sending crash reports until restart.
  setCrashReportChoice(next.choice);

  return NextResponse.json({ choice: next.choice, decidedAt: next.decidedAt });
}
