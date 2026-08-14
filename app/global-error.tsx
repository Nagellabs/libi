"use client";

// Root error boundary — catches errors in the root layout and otherwise
// unhandled React render errors, and reports them to Sentry. The error object
// is anonymous; identity/secret scrubbing still runs via beforeSend.
import * as Sentry from "@sentry/nextjs";
import NextError from "next/error";
import { useEffect } from "react";

export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html>
      <body>
        <NextError statusCode={0} />
      </body>
    </html>
  );
}
