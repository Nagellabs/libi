"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { Mail, Check, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LEGAL_LINKS } from "@/lib/legal-links";
import { trackEvent } from "@/lib/analytics/client";
import { useRuntimeUpdate } from "@/lib/queries/runtime-update";
import { submitWaitlistSignup } from "@/lib/waitlist-api";

/**
 * Waitlist signup card for the libi Pro membership.
 *
 * The address is POSTed to the marketing site's `/api/waitlist` and stored in
 * Firestore — see lib/waitlist-api.ts. localStorage is still written, but its
 * job has changed: it no longer *is* the waitlist, it only remembers that this
 * browser already joined so the card can show the confirmed state instead of an
 * empty form. The server is the record.
 *
 * That distinction drives the two things below that look like rough edges:
 *
 *   - The local entry is written only after the POST succeeds. Showing
 *     "you're on the list" for a request that failed is the one outcome worth
 *     engineering against — the user stops trying, and nobody has their address.
 *
 *   - "Leave waitlist" clears this browser's copy and says so, because the
 *     endpoint deliberately cannot delete (its service account holds
 *     `datastore.entities.create` and nothing else). Removing the stored
 *     address is an email to us. The button does not claim otherwise.
 *
 * Consent is the act of submitting: an address typed into a form headed "Join
 * waitlist" and sent by pressing the button is an unambiguous affirmative act
 * for one stated purpose. NOTICE below is what makes that true — it says where
 * the address goes and what it is used for, in view, before anything is sent.
 * If it ever stops describing what the server actually does, the consent stops
 * being informed; change them together.
 *
 * Entries live under the `libi:` prefix, which the reset-preferences flow in
 * components/settings/general-tab.tsx sweeps, so they clear correctly.
 */

interface WaitlistEntry {
  email: string;
  registeredAt: string; // ISO string
}

interface WaitlistCardProps {
  /** Single membership today. Kept as a union so a second plan can be added later. */
  featureKey: "pro";
  featureName: string;
  /** Short pitch line shown above the form. */
  blurb: string;
  /** Compact mode: smaller spacing, used inside Settings. */
  compact?: boolean;
}

const STORAGE_PREFIX = "libi:waitlist:";

/**
 * The point-of-collection notice. Short enough to be read, specific about the
 * two things a person needs before pressing the button: the address leaves this
 * machine, and it is used for exactly one message.
 */
const NOTICE =
  "We'll store your address on libi's servers and use it for this one announcement — nothing else. Unsubscribe any time.";

/** Same-window notification. `storage` events only fire in *other* windows. */
const CHANGE_EVENT = "libi:waitlist-change";

function parseEntry(raw: string | null): WaitlistEntry | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<WaitlistEntry>;
    if (!parsed.email || !parsed.registeredAt) return null;
    return parsed as WaitlistEntry;
  } catch {
    return null;
  }
}

/**
 * useSyncExternalStore calls getSnapshot on every render and bails out only if
 * the result is referentially equal to the last one — so parsing fresh JSON
 * each time would loop forever. Cache the parsed object against the raw string
 * it came from, per storage key.
 */
const snapshotCache = new Map<string, { raw: string | null; entry: WaitlistEntry | null }>();

function readSnapshot(storageKey: string): WaitlistEntry | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey);
  } catch {
    raw = null;
  }
  const cached = snapshotCache.get(storageKey);
  if (cached && cached.raw === raw) return cached.entry;
  const entry = parseEntry(raw);
  snapshotCache.set(storageKey, { raw, entry });
  return entry;
}

function writeEntry(storageKey: string, entry: WaitlistEntry) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(entry));
  } catch {
    // A full or blocked localStorage must not undo a signup the server accepted.
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function clearEntry(storageKey: string) {
  try {
    localStorage.removeItem(storageKey);
  } catch {
    /* nothing to clear */
  }
  window.dispatchEvent(new Event(CHANGE_EVENT));
}

function isValidEmail(value: string): boolean {
  // Pragmatic validation — match what most apps do, not RFC 5321 in full.
  // The server validates independently; this only saves a round trip.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return iso;
  }
}

export function WaitlistCard({
  featureKey,
  featureName,
  blurb,
  compact = false,
}: WaitlistCardProps) {
  const storageKey = STORAGE_PREFIX + featureKey;
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The running runtime version, for the signup record. This query is already
  // mounted app-wide by the sidebar with a 5-minute staleTime, so in practice
  // this is a cache read rather than a request — and it never rejects on a
  // network failure, so a missing version just means the field is omitted.
  const { data: runtime } = useRuntimeUpdate();

  const subscribe = useCallback((onChange: () => void) => {
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  // `undefined` means "not read yet". The server snapshot is what React uses
  // for SSR *and* for the hydration render, so returning it here renders the
  // skeleton on first paint and avoids the form flashing before we know this
  // browser already joined — without a setState-in-effect to do it.
  const entry = useSyncExternalStore<WaitlistEntry | null | undefined>(
    subscribe,
    useCallback(() => readSnapshot(storageKey), [storageKey]),
    () => undefined,
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const trimmed = email.trim();
    if (!trimmed) {
      setError("Email is required.");
      return;
    }
    if (!isValidEmail(trimmed)) {
      setError("That doesn't look like a valid email.");
      return;
    }

    setSubmitting(true);
    const result = await submitWaitlistSignup(
      trimmed,
      featureKey,
      runtime?.current.version,
    );
    setSubmitting(false);

    if (!result.ok) {
      setError(result.error ?? "Couldn't join the waitlist. Please try again.");
      return;
    }

    // Only now is the signup real, so only now do we remember it locally.
    // The write notifies the store, which re-renders this card as confirmed.
    writeEntry(storageKey, { email: trimmed, registeredAt: new Date().toISOString() });
    setEmail("");
    // Bounded params only — the address itself is never an analytics param.
    trackEvent("pro_waitlist_joined", { plan: featureKey });
  };

  const handleLeave = () => {
    clearEntry(storageKey);
  };

  // Skeleton-style placeholder until we have read localStorage, to avoid
  // flicker between "form" and "registered" on first paint.
  if (entry === undefined) {
    return (
      <div
        className={`rounded-lg border border-border bg-card ${compact ? "p-3" : "p-5"}`}
      >
        <div className="h-9 w-full animate-pulse rounded-md bg-muted/50" />
      </div>
    );
  }

  if (entry) {
    return (
      <div
        className={`rounded-lg border border-emerald-500/30 bg-emerald-500/5 ${compact ? "p-3" : "p-5"}`}
      >
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-600 dark:text-emerald-400">
            <Check className="size-3.5" strokeWidth={3} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-foreground">
              You&rsquo;re on the {featureName} waitlist
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {entry.email} &middot; joined {formatDate(entry.registeredAt)}
            </p>
            <p className="mt-2 text-xs text-muted-foreground">
              We&rsquo;ll email you the moment {featureName} is ready. To have your
              address deleted, email{" "}
              <a
                href="mailto:admin@nagellabs.com?subject=Remove%20me%20from%20the%20libi%20Pro%20waitlist"
                className="cursor-pointer underline underline-offset-2 hover:text-foreground"
              >
                admin@nagellabs.com
              </a>
              .
            </p>
          </div>
          <button
            type="button"
            onClick={handleLeave}
            aria-label="Hide this on this computer"
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            title="Hide this on this computer (does not delete your address)"
          >
            <X className="size-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={`rounded-lg border border-border bg-card ${compact ? "p-3" : "p-5"}`}
    >
      <p className={`text-sm text-muted-foreground ${compact ? "mb-2" : "mb-3"}`}>
        {blurb}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <div className="relative min-w-0 flex-1">
          <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(null);
            }}
            placeholder="you@example.com"
            aria-label={`Email for ${featureName} waitlist`}
            disabled={submitting}
            className="pl-9"
          />
        </div>
        <Button type="submit" disabled={submitting} className="cursor-pointer shrink-0">
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Joining&hellip;
            </>
          ) : (
            "Join waitlist"
          )}
        </Button>
      </div>

      {/* The notice stays visible whether or not there is an error — it is the
          disclosure the signup rests on, not a hint that a validation message
          may replace. */}
      <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
        {NOTICE}{" "}
        <a
          href={LEGAL_LINKS.privacy}
          target="_blank"
          rel="noreferrer"
          className="cursor-pointer underline underline-offset-2 hover:text-foreground"
        >
          Privacy Policy
        </a>
        .
      </p>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </form>
  );
}
