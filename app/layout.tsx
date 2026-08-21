import type { Metadata } from "next";
import { Geist, Geist_Mono, Fraunces } from "next/font/google";
import { QueryProvider } from "@/components/providers/query-provider";
import { Toaster } from "@/components/ui/sonner";
import { UpdateToast } from "@/components/layout/update-toast";
import { MediaConsoleNoiseFilter } from "@/components/providers/media-console-noise";
import { BundledFonts } from "@/components/providers/bundled-fonts";
import { getCrashReportSettings } from "@/lib/db/settings";
import { SENTRY_KILL_SWITCHED } from "@/lib/sentry/config";
import { crashReportSeedScript } from "@/lib/sentry/seed-script";
import "./globals.css";

// The seed below reads the settings DB, so this layout is per-request. It
// already was in practice — `app/(app)/layout.tsx` is force-dynamic and is
// what every real page renders under — but saying so here keeps a build-time
// prerender from baking one machine's choice into the HTML.
export const dynamic = "force-dynamic";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

const fraunces = Fraunces({
  variable: "--font-serif",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  title: "Libi — AI Video Studio",
  description:
    "Create canvas-based video compositions with AI-powered scene generation.",
};

/**
 * The persisted crash-report choice + the live kill-switch, for the inline
 * seed below.
 *
 * Every failure resolves to the same shape the browser would have inferred on
 * its own, because this must never be able to break rendering. The `unset`
 * default is the disclosed default-on behaviour, not a fail-closed choice —
 * failing closed here would silently drop the most valuable crash reports (a
 * fresh install's) whenever the DB is merely slow to migrate.
 */
function crashReportSeed(): { choice: string; killSwitched: boolean } {
  try {
    return {
      choice: getCrashReportSettings().choice,
      killSwitched: SENTRY_KILL_SWITCHED,
    };
  } catch {
    return { choice: "unset", killSwitched: SENTRY_KILL_SWITCHED };
  }
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} ${fraunces.variable} dark h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <meta name="theme-color" content="#16181a" media="(prefers-color-scheme: dark)" />
        <meta name="theme-color" content="#f7f4ef" media="(prefers-color-scheme: light)" />
        {/*
          Seed the crash-report gate BEFORE any client JS runs. It has to be an
          inline head script rather than an effect or a fetch:
          `browserSessionIntegration` sends a session-start envelope
          synchronously inside `Sentry.init`, so anything that arrives later is
          already too late. See lib/sentry/seed-script.ts for why the
          localStorage mirror alone left an opted-out user reporting one
          session per launch.
        */}
        <script dangerouslySetInnerHTML={{ __html: crashReportSeedScript(crashReportSeed()) }} />
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");var d=t==="light"?false:true;if(d){document.documentElement.classList.add("dark")}else{document.documentElement.classList.remove("dark")}var m=document.querySelector('meta[name="theme-color"]:not([media])');if(!m){m=document.createElement("meta");m.name="theme-color";document.head.appendChild(m)}m.content=d?"#16181a":"#f7f4ef"}catch(e){}})()`,
          }}
        />
      </head>
      <body className="h-screen overflow-hidden bg-background text-foreground">
        <QueryProvider>
          {/* Dev-only: keeps mediabunny's non-actionable diagnostics from
              becoming blocking dev-overlay cards. See the module for why. */}
          <MediaConsoleNoiseFilter />
          <BundledFonts />
          {children}
          {/* App-wide update offer — must live inside QueryProvider (it reads
              the runtime-update query) and renders through the Toaster below. */}
          <UpdateToast />
        </QueryProvider>
        <Toaster />
      </body>
    </html>
  );
}
