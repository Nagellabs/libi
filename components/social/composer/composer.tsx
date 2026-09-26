"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  isPartialPost,
  SocialApiError,
  useComposeRequestId,
  useCreateSocialPost,
  useSocialAccounts,
  useSocialFit,
  useSocialPost,
  useSocialStatus,
  useUpdateSocialPost,
} from "@/lib/queries/social";
import type { CreatePostInput, SocialAccount, TikTokCreatorInfo } from "@/lib/social/types";
import type { SocialPlatform } from "@/lib/social/catalog";
import { toDatetimeLocal } from "@/lib/social/format";
import { isComposablePlatform, platformLabel } from "@/lib/social/catalog";
import {
  clearComposerDraft,
  composerDraftKey,
  draftIsMeaningful,
  readComposerDraft,
  writeComposerDraft,
} from "@/hooks/social/use-composer-draft";
import { AgentOnlyTargets } from "@/components/social/platform-support";

/** An account the composer can actually build a post for — the narrowing the
 *  Targets step and `defaultOptions` both depend on. */
type ComposableAccount = SocialAccount & { platform: SocialPlatform };
import { CaptionStep, captionOverLimit } from "./caption-step";
import { MediaStep } from "./media-step";
import { ReviewStep } from "./review-step";
import { TargetInstagram } from "./target-instagram";
import { TargetTikTok } from "./target-tiktok";
import { useUploadJob } from "./use-upload-job";
import { WhenStep, type WhenDraft } from "./when-step";
import {
  basename,
  defaultOptions,
  postTypeOf,
  seedFromCreatorInfo,
  STEPS,
  STEP_LABEL,
  type ComposerIntent,
  type LatestExport,
  type Step,
  type TargetDraft,
  type TikTokConsent,
} from "./types";

export interface ComposerProps {
  intent: ComposerIntent;
  latestExport: LatestExport | null;
  onExportRequested: () => void;
  /** `null` when the post exists but libi never got its id — a 207 partial,
   *  whose body carries the per-target failures and no post. */
  onDone: (postId: string | null) => void;
}

/**
 * The last mile: ONE piece's export becomes ONE post.
 *
 * Everything wider than that — writing the caption, deciding where a piece
 * should go, anything spanning several pieces or posts, recurrence, ads —
 * belongs to the agent and is reached through "Ask the agent". This component
 * only gathers what the platforms themselves require and hands it to the
 * provider.
 *
 * The draft in progress is LOCAL state: nothing is persisted until Zernio has
 * the post. `requestId` is NOT: it comes from the server
 * (`useComposeRequestId`), so closing and reopening this composer keeps the
 * identity of a post whose outcome libi never learned. With no request-id
 * header on the provider's MCP (`.superpowers/sdd/zernio-live-shapes.md`),
 * that id plus the local intent row is the whole dedupe contract, which is
 * also why a PUBLISH NOW whose outcome is UNKNOWN never retries itself here.
 */
export function Composer({ intent, latestExport, onExportRequested, onDone }: ComposerProps) {
  const status = useSocialStatus();
  const accounts = useSocialAccounts();
  const existing = useSocialPost(intent.draftPostId ?? null);
  const create = useCreateSocialPost();
  const update = useUpdateSocialPost();
  const upload = useUploadJob();

  /**
   * The half-finished composer this machine last held for this piece, read
   * ONCE at mount. Leaving the Posting tab unmounts this component, so
   * without it every caption and target choice was lost on a tab click.
   */
  const draftKey = composerDraftKey(intent.pieceId, intent.draftPostId ?? null);
  const savedRef = useRef(readComposerDraft(draftKey));
  const saved = savedRef.current;

  const [step, setStep] = useState<Step>(saved?.step ?? "media");
  const [furthest, setFurthest] = useState<Step>(saved?.step ?? "media");
  const [exportPath, setExportPath] = useState<string | null>(intent.exportPath ?? saved?.exportPath ?? latestExport?.filePath ?? null);
  /**
   * Whether this composer already has the export it is going to post.
   *
   * `latestExport` comes from `useAllJobs({ kind: "export" })` in the Posting
   * tab, which is NOT prefetched: on a fresh mount it is `null` for as long as
   * `GET /api/jobs?kind=export` is in flight, so seeding `exportPath` once in
   * `useState` above left the Media step on "this piece has no export yet —
   * export it and come straight back", telling the user to re-render a piece
   * whose export the page was fetching at that moment (QA 2026-09-21,
   * finding 1). It self-healed on a tab remount, which is exactly why it read
   * as flaky rather than broken.
   *
   * So the seed is re-applied WHEN the query resolves, and this ref is what
   * keeps it from happening twice: once the export is decided — by the intent,
   * by that first resolution, or by the user picking another one from the
   * Media step's own list — a later `latestExport` never overrides it.
   */
  const exportDecided = useRef(exportPath !== null);
  const [seenLatestExport, setSeenLatestExport] = useState(latestExport?.filePath ?? null);
  if ((latestExport?.filePath ?? null) !== seenLatestExport) {
    // Compare-during-render, not setState-in-effect (this repo's lint rule;
    // same shape as `posting-tab.tsx`'s `seenNonce`) — so the first paint that
    // can know about the export already shows it.
    setSeenLatestExport(latestExport?.filePath ?? null);
    if (!exportDecided.current && latestExport) {
      exportDecided.current = true;
      setExportPath(latestExport.filePath);
    }
  }
  /** The Media step's own picker. An explicit choice is final for this flow. */
  const pickExport = useCallback((filePath: string) => {
    exportDecided.current = true;
    setExportPath(filePath);
  }, []);
  const [targets, setTargets] = useState<TargetDraft[]>([]);
  const [consents, setConsents] = useState<Record<string, TikTokConsent>>({});
  const [creatorInfo, setCreatorInfo] = useState<Record<string, TikTokCreatorInfo>>({});
  const [caption, setCaption] = useState(saved?.caption ?? "");
  const [when, setWhen] = useState<WhenDraft>(saved?.when ?? { mode: "draft" });
  const [submitting, setSubmitting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [perTargetErrors, setPerTargetErrors] = useState<Array<{ platform: string; accountId: string; error: string }>>([]);
  const seeded = useRef(false);
  /** Accounts whose TikTok switches have already been decided — by creator
   *  info, by a restored draft, or by the user. Creator info seeds ONCE. */
  const interactionsSeeded = useRef(new Set<string>());
  /** One send at a time, whatever the UI does. `submitting` is state and lags
   *  a synchronous double click by a render; this does not. */
  const inFlight = useRef(false);

  // The id is the server's to decide, and it is latched: whatever answer
  // arrives first is this compose flow's identity for as long as it is open.
  const seedId = useComposeRequestId(intent.pieceId, intent.draftPostId ?? null);
  const [requestId, setRequestId] = useState<string | null>(null);
  useEffect(() => {
    if (requestId) return;
    if (seedId.data?.requestId) setRequestId(seedId.data.requestId);
    // A route that could not answer must not block composing: mint one here
    // and lose only the cross-remount identity, never the send.
    else if (seedId.isError) setRequestId(crypto.randomUUID());
  }, [requestId, seedId.data, seedId.isError]);

  // Memoized because the seeding effect depends on it: a fresh object literal
  // every render would re-run that effect forever.
  const defaults = useMemo(
    () => status.data?.settings.defaults ?? { instagramType: "reel" as const, aiLabel: true },
    [status.data?.settings.defaults],
  );
  const tz = status.data?.settings.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const active: SocialAccount[] = useMemo(() => (accounts.data ?? []).filter((a) => a.active), [accounts.data]);
  /**
   * Split by what THIS composer can build a post for. An account on a
   * platform libi's UI doesn't drive yet (Facebook, X, YouTube) is connected
   * and perfectly usable — by the AGENT, through the provider's MCP — so the
   * Targets step lists it and says so, rather than hiding a connected account
   * or offering a checkbox that would hand `defaultOptions` a platform it has
   * no options for.
   */
  const connected: ComposableAccount[] = useMemo(
    () => active.filter((a): a is ComposableAccount => isComposablePlatform(a.platform)),
    [active],
  );
  const agentOnly: SocialAccount[] = useMemo(() => active.filter((a) => !isComposablePlatform(a.platform)), [active]);

  // Seed once: an existing Zernio draft supplies the caption and targets;
  // otherwise every connected account starts selected, which is what makes
  // the Media step able to check the export against something.
  useEffect(() => {
    if (seeded.current || !connected.length) return;
    if (intent.draftPostId && !existing.data) return;
    seeded.current = true;
    const post = existing.data;
    if (post) {
      setCaption(post.content);
      // Zernio echoes Instagram's own `platformSpecificData` back on `t.options`
      // fine, but never `tiktok_settings` (verified live) — a reopened TikTok
      // target arrives with `t.options` undefined every time. Rather than
      // falling back to `defaultOptions` (and re-asking for consent on a
      // target the user already configured), restore what libi itself last
      // stamped into `metadata.libi.targetOptions`. `restoredConsents` is
      // built alongside it: a target's consent boxes are only pre-checked
      // when they are being restored from libi's OWN record of what the user
      // chose, never invented — a target seeded from `defaultOptions` still
      // asks fresh, exactly as before.
      const stored = post.libi?.targetOptions ?? [];
      const restoredConsents: Record<string, TikTokConsent> = {};
      setTargets(
        post.targets
          .filter((t) => connected.some((a) => a.id === t.accountId))
          .flatMap<TargetDraft>((t) => {
            // `connected` already excludes agent-only platforms, so this
            // narrows the wide `SocialTarget.platform` to what the draft
            // types below need without a cast.
            if (!isComposablePlatform(t.platform)) return [];
            const platform = t.platform;
            if (t.options) return { platform, accountId: t.accountId, options: t.options };
            const restored = stored.find((o) => o.platform === platform);
            if (restored) {
              if (platform === "tiktok") {
                restoredConsents[t.accountId] = { preview: true, express: true };
                // What the user chose last time outranks the platform's
                // defaults: creator info must not re-seed these switches.
                interactionsSeeded.current.add(t.accountId);
              }
              return { platform, accountId: t.accountId, options: restored };
            }
            return { platform, accountId: t.accountId, options: defaultOptions(platform, defaults) };
          }),
      );
      if (Object.keys(restoredConsents).length) setConsents((c) => ({ ...restoredConsents, ...c }));
      // A DRAFT keeps whatever `scheduledFor` it was cancelled with, and that
      // time means nothing (verified live). Only a post Zernio itself calls
      // `scheduled` is seeded as a schedule.
      if (post.status === "scheduled" && post.scheduledFor) {
        // In the POST's zone, not the browser's: the field is labelled with
        // `post.timezone`, so reading the instant in any other zone shows the
        // wrong wall clock — and re-saving would MOVE the schedule.
        const zone = post.timezone ?? tz;
        setWhen({ mode: "schedule", scheduledFor: toDatetimeLocal(post.scheduledFor, zone), timezone: zone });
      }
      return;
    }
    // The machine's own saved draft outranks "select everything": those were
    // choices the user made. Accounts that have since been disconnected are
    // dropped rather than carried as targets that cannot be posted to.
    const savedTargets = (saved?.targets ?? []).filter((t) => connected.some((a) => a.id === t.accountId));
    if (savedTargets.length) {
      setTargets(savedTargets);
      return;
    }
    setTargets(connected.map((a) => ({ platform: a.platform, accountId: a.id, options: defaultOptions(a.platform, defaults) })));
  }, [connected, existing.data, intent.draftPostId, defaults, tz, saved]);

  /**
   * Autosave, on every change the user makes. Cheap (one small JSON write to
   * this machine) and it runs on the state that is already being rendered, so
   * there is no separate "unsaved" concept to get out of step with the form.
   *
   * `draftIsMeaningful` keeps an untouched composer from leaving anything
   * behind: merely opening the Posting tab must not make a piece look like it
   * has work in progress.
   */
  useEffect(() => {
    const d = { step, exportPath, targets, caption, when };
    if (draftIsMeaningful(d)) writeComposerDraft(draftKey, d);
    else clearComposerDraft(draftKey);
  }, [draftKey, step, exportPath, targets, caption, when]);

  const fitTargets = useMemo(
    () => targets.map((t) => ({ platform: t.platform, postType: postTypeOf(t) })),
    [targets],
  );
  const fitInput = useMemo(
    () => (exportPath && fitTargets.length ? { exportPath, targets: fitTargets } : null),
    [exportPath, fitTargets],
  );
  const fitQuery = useSocialFit(fitInput);
  const currentFit = fitQuery.data ?? null;
  const fitPending = !!fitInput && fitQuery.isLoading;
  const fitFailed = !!fitInput && fitQuery.isError;
  const fitOk = !!currentFit && currentFit.verdicts.length > 0 && currentFit.verdicts.every((v) => v.ok);

  /**
   * What the Media step can offer, the SELECTED one always among them.
   *
   * It used to be `latestExport` plus `intent.exportPath`, which is the same
   * list right up until the jobs query polls a NEWER export: the selected
   * path then dropped out of `choices`, and `media-step.tsx` fell back to
   * `latestExport` — so the step described a file the composer was not
   * actually going to post, and the `<select>` had no option matching its own
   * value. `currentFit.probe` is the probe OF `exportPath` (it is what
   * `fitInput` asks about), so it is the right dimensions for this row.
   */
  const exportChoices: LatestExport[] = useMemo(() => {
    const out: LatestExport[] = [];
    if (latestExport) out.push(latestExport);
    if (exportPath && !out.some((e) => e.filePath === exportPath) && currentFit) {
      out.push({ filePath: exportPath, ...currentFit.probe });
    }
    return out;
  }, [latestExport, exportPath, currentFit]);

  const probe = currentFit?.probe ?? (latestExport ? { width: latestExport.width, height: latestExport.height } : null);

  const tiktokTargets = targets.filter((t) => t.platform === "tiktok");
  const consentOf = (accountId: string): TikTokConsent => consents[accountId] ?? { preview: false, express: false };
  const duration = currentFit?.probe.durationSeconds;
  const targetsReady =
    targets.length > 0 &&
    tiktokTargets.every(
      (t) =>
        consentOf(t.accountId).preview &&
        consentOf(t.accountId).express &&
        creatorInfo[t.accountId]?.canPostMore !== false &&
        // The per-account cap TikTok returned, which can be lower than the
        // catalog's: it is already RENDERED on the target, and a gate is what
        // stops the export sailing through Media only to be refused by TikTok.
        !(duration !== undefined && duration > (creatorInfo[t.accountId]?.maxVideoSeconds ?? Infinity)) &&
        (t.options.platform !== "tiktok" || !!t.options.tiktok.privacyLevel),
    );

  const nextEnabled: Record<Step, boolean> = {
    media: !!exportPath && fitOk,
    targets: targetsReady,
    caption: !captionOverLimit(caption, targets),
    when: when.mode !== "schedule" || !!when.scheduledFor,
    review: false,
  };

  /**
   * WHY the Targets step's Next is off, in the user's terms.
   *
   * A disabled button that says only "Next" reads as broken (AGENTS.md's own
   * UI rule), and this one is disabled by default on every TikTok post — the
   * two consent boxes start unticked, several screen-lines below the button
   * (QA 2026-09-21, finding 7). The conditions are the same ones
   * `targetsReady` is built from, in the order a user would fix them.
   */
  const targetsBlockedReason = ((): string | null => {
    if (targetsReady) return null;
    if (targets.length === 0) return "Pick at least one account to post to.";
    const needsConsent = tiktokTargets.filter((t) => !consentOf(t.accountId).preview || !consentOf(t.accountId).express);
    if (needsConsent.length > 0) {
      return needsConsent.length > 1
        ? "Tick both TikTok consent boxes on each TikTok account above."
        : "Tick both TikTok consent boxes above — TikTok requires them before it will accept the post.";
    }
    if (tiktokTargets.some((t) => creatorInfo[t.accountId]?.canPostMore === false)) {
      return "TikTok says this account has reached its posting limit for now.";
    }
    const tooLong = tiktokTargets.find(
      (t) => duration !== undefined && duration > (creatorInfo[t.accountId]?.maxVideoSeconds ?? Infinity),
    );
    if (tooLong) return "This export is longer than TikTok allows on this account — see the limit above.";
    if (tiktokTargets.some((t) => t.options.platform === "tiktok" && !t.options.tiktok.privacyLevel)) {
      return "Choose who can see this on TikTok.";
    }
    return "Something on a target above still needs a choice.";
  })();

  /**
   * The media to SEND, which is never the media the provider read back.
   *
   * Attaching an upload promotes its URL from `media.zernio.com/temp/…` to
   * `media.zernio.com/media/…`, and the promoted URL 404s — re-sending it
   * fails the whole update with "Some media files failed to upload", and
   * omitting `media_items` fails identically (verified live 2026-09-20). So:
   * this upload's own URL first, then the one libi stamped into
   * `metadata.libi.mediaUrl` when it uploaded, and only as a last resort the
   * echoed `post.media` — which is all a post written before that stamp
   * existed has.
   */
  const media = useMemo((): CreatePostInput["media"] | null => {
    if (upload.result) {
      return [
        {
          url: upload.result.publicUrl,
          type: "video" as const,
          filename: upload.result.filename,
          sizeBytes: upload.result.sizeBytes,
          mimeType: upload.result.contentType,
        },
      ];
    }
    if (exportPath) return null;
    const stored = existing.data?.libi?.mediaUrl;
    if (stored) return [{ url: stored, type: "video" as const }];
    if (existing.data?.media.length) return existing.data.media;
    return null;
  }, [upload.result, exportPath, existing.data]);

  /**
   * The targets as they go on the WIRE. TikTok's two consent fields are the
   * checkboxes, read here — never the constant `true` the option defaults used
   * to carry, which made both consents unbypassable-looking and bypassable in
   * fact (uncheck them after Review, and a `true` still went out).
   */
  const wireTargets = useMemo(
    (): CreatePostInput["targets"] =>
      targets.map((t) => {
        if (t.options.platform !== "tiktok") return { platform: t.platform, accountId: t.accountId, options: t.options };
        const c = consents[t.accountId] ?? { preview: false, express: false };
        return {
          platform: t.platform,
          accountId: t.accountId,
          options: {
            platform: "tiktok",
            tiktok: { ...t.options.tiktok, contentPreviewConfirmed: c.preview, expressConsentGiven: c.express },
          },
        };
      }),
    [targets, consents],
  );

  const body: CreatePostInput | null = useMemo(() => {
    if (!media || !requestId) return null;
    return {
      requestId,
      content: caption,
      media,
      targets: wireTargets,
      when: when.mode === "schedule" ? { ...when, scheduledFor: when.scheduledFor } : when,
      libi: {
        pieceId: intent.pieceId,
        pieceName: intent.pieceName,
        exportFile: exportPath ? basename(exportPath) : undefined,
      },
    };
  }, [media, requestId, caption, wireTargets, when, intent.pieceId, intent.pieceName, exportPath]);

  const goto = useCallback(
    (next: Step) => {
      setStep(next);
      setFurthest((f) => (STEPS.indexOf(next) > STEPS.indexOf(f) ? next : f));
    },
    [],
  );

  const advance = () => {
    const i = STEPS.indexOf(step);
    const next = STEPS[i + 1];
    if (!next) return;
    // Leaving Targets is where the bytes start moving: one upload per export
    // path, cached with its expiry, so a second Next never re-uploads.
    if (step === "targets" && exportPath) {
      void upload.start(exportPath, intent.pieceId).catch(() => {
        /* surfaced through `upload.error` */
      });
    }
    goto(next);
  };

  /**
   * Send it — once.
   *
   * Three things here are the last line of defence against a DOUBLE POST, and
   * none of them is cosmetic:
   *
   *  - a 207 is `res.ok`. The post EXISTS with some targets failed, and the
   *    body is `{ error, perTarget }` — reading `.post` off it threw a
   *    TypeError, which rendered as "libi could not confirm…" plus a checkbox
   *    inviting a republish while Instagram was already live. It is its own
   *    outcome, and it NEVER raises the confirmation gate.
   *  - the confirmation gate is raised for the adapter's own precise signal
   *    (`confirm_republish`), or for a publish-now that failed AFTER the
   *    request left with no answer libi can read (5xx / network). A libi-side
   *    400/422, or an upload that failed before a byte moved, is a plain
   *    failure: crying wolf trains the user to tick the box.
   *  - one send at a time, guarded by a ref rather than by `submitting`, which
   *    lags a synchronous second click by a render.
   */
  const submit = useCallback(
    async (republishConfirmedByUser?: true) => {
      if (inFlight.current) return;
      if (!requestId) {
        setLastError("libi could not work out this post's request id — reopen the composer and try again.");
        return;
      }
      inFlight.current = true;
      setSubmitting(true);
      setLastError(null);
      setPerTargetErrors([]);
      // Whether the write itself left libi. Everything before this point —
      // the upload, building the body — fails with the provider untouched.
      let sent = false;
      try {
        const uploaded = exportPath ? await upload.start(exportPath, intent.pieceId) : null;
        const mediaNow: CreatePostInput["media"] = uploaded
          ? [
              {
                url: uploaded.publicUrl,
                type: "video" as const,
                filename: uploaded.filename,
                sizeBytes: uploaded.sizeBytes,
                mimeType: uploaded.contentType,
              },
            ]
          : media ?? [];
        const input: CreatePostInput & { exportPath?: string; createdBy: "ui" } = {
          requestId,
          content: caption,
          media: mediaNow,
          targets: wireTargets,
          when,
          libi: {
            pieceId: intent.pieceId,
            pieceName: intent.pieceName,
            exportFile: exportPath ? basename(exportPath) : undefined,
          },
          exportPath: exportPath ?? undefined,
          createdBy: "ui",
          ...(republishConfirmedByUser ? { republishConfirmedByUser } : {}),
        };
        // Extends the post's OWN existing `metadata.libi` (never invents one):
        // `toUpdateBody` folds the current `targets` into `targetOptions` on
        // top of it, which is what lets a later reopen of this same TikTok
        // draft restore its settings instead of re-asking for consent.
        const updateLibi = existing.data?.libi?.pieceId
          ? {
              pieceId: existing.data.libi.pieceId,
              pieceName: existing.data.libi.pieceName,
              exportFile: exportPath ? basename(exportPath) : existing.data.libi.exportFile,
              appVersion: existing.data.libi.appVersion,
              requestId: existing.data.libi.requestId,
              mediaUrl: existing.data.libi.mediaUrl,
            }
          : undefined;
        sent = true;
        const result = intent.draftPostId
          ? // An update carries its MEDIA too: the provider keeps none of it
            // implicitly, and the URL on the post is the promoted one that
            // 404s — so `mediaNow` (this upload's own URL, or the stamped
            // original) is what goes back.
            await update.mutateAsync({
              id: intent.draftPostId,
              requestId,
              content: caption,
              media: mediaNow,
              targets: input.targets,
              when,
              libi: updateLibi,
            })
          : await create.mutateAsync(input);

        if (isPartialPost(result)) {
          // Success with casualties. The post is live on the targets that
          // worked: show the provider's own words for the ones that did not,
          // and close the flow — never offer a republish.
          setPerTargetErrors(result.perTarget.map((t) => ({ platform: t.platform, accountId: t.accountId ?? "", error: t.error })));
          setNeedsConfirmation(false);
          clearComposerDraft(draftKey);
          onDone(null);
          return;
        }
        const post = result.post;
        setPerTargetErrors(
          post.targets?.filter((t) => t.error).map((t) => ({ platform: t.platform, accountId: t.accountId, error: t.error! })) ?? [],
        );
        setNeedsConfirmation(false);
        clearComposerDraft(draftKey);
        onDone(post.id);
      } catch (e) {
        setLastError(e instanceof Error ? e.message : String(e));
        const api = e instanceof SocialApiError ? e : null;
        // The adapter's own precise signal: it could not establish whether an
        // earlier attempt with this id went out.
        const refusedPendingHuman = api?.body.error === "confirm_republish";
        // …or this publish left and came back unreadable. A status libi's own
        // routes produced (4xx) is not that; a 5xx or a transport failure is.
        const outcomeUnknown = sent && when.mode === "now" && (!api || api.status >= 500);
        setNeedsConfirmation(refusedPendingHuman || outcomeUnknown);
      } finally {
        inFlight.current = false;
        setSubmitting(false);
      }
    },
    [exportPath, upload, intent.pieceId, intent.pieceName, intent.draftPostId, existing.data, requestId, caption, media, wireTargets, when, create, update, onDone, draftKey],
  );

  if (accounts.isLoading && !accounts.data) {
    return (
      <div className="space-y-3" data-testid="composer-skeleton">
        <Skeleton className="h-4 w-40" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  const showNext = step !== "review" && !(step === "media" && !exportPath);

  return (
    <div className="flex gap-6" data-testid="composer">
      <ol className="w-32 shrink-0 space-y-1">
        {STEPS.map((s) => {
          const reachable = STEPS.indexOf(s) <= STEPS.indexOf(furthest);
          const done = STEPS.indexOf(s) < STEPS.indexOf(step);
          return (
            <li key={s}>
              <button
                type="button"
                data-testid={`rail-${s}`}
                disabled={!reachable}
                aria-current={step === s ? "step" : undefined}
                onClick={() => setStep(s)}
                className={`w-full cursor-pointer rounded-md px-2 py-1 text-left text-sm ${
                  step === s ? "bg-muted font-medium" : reachable ? "text-muted-foreground hover:bg-muted" : "text-muted-foreground/40"
                } ${reachable ? "" : "cursor-not-allowed"}`}
              >
                {done ? "✓ " : ""}
                {STEP_LABEL[s]}
              </button>
            </li>
          );
        })}
      </ol>

      <div className="min-w-0 flex-1 space-y-4">
        {step === "media" && (
          <MediaStep
            latestExport={latestExport}
            exportPath={exportPath}
            choices={exportChoices}
            onPick={pickExport}
            fit={currentFit}
            fitPending={fitPending}
            fitFailed={fitFailed}
            hasTargets={targets.length > 0}
            onExportRequested={onExportRequested}
            onChangeTargets={() => goto("targets")}
          />
        )}

        {step === "targets" && (
          <div className="space-y-4" data-testid="targets-step">
            {connected.length === 0 && agentOnly.length === 0 && (
              <p className="text-sm text-muted-foreground">No accounts are connected at your provider yet.</p>
            )}
            {connected.map((a) => {
              const chosen = targets.find((t) => t.accountId === a.id);
              return (
                <div key={a.id} className="space-y-3 rounded-lg border border-border p-3">
                  <label className="flex items-center gap-2 text-sm font-medium">
                    <input
                      type="checkbox"
                      className="cursor-pointer"
                      data-testid={`target-toggle-${a.id}`}
                      checked={!!chosen}
                      onChange={(e) =>
                        setTargets((prev) =>
                          e.target.checked
                            ? [...prev, { platform: a.platform, accountId: a.id, options: defaultOptions(a.platform, defaults) }]
                            : prev.filter((t) => t.accountId !== a.id),
                        )
                      }
                    />
                    {platformLabel(a.platform)} @{a.username}
                  </label>

                  {chosen && chosen.options.platform === "instagram" && (
                    <TargetInstagram
                      options={chosen.options.instagram}
                      probe={probe}
                      onChange={(next) =>
                        setTargets((prev) =>
                          prev.map((t) => (t.accountId === a.id ? { ...t, options: { platform: "instagram", instagram: next } } : t)),
                        )
                      }
                    />
                  )}

                  {chosen && chosen.options.platform === "tiktok" && (
                    <TargetTikTok
                      accountId={a.id}
                      options={chosen.options.tiktok}
                      consent={consentOf(a.id)}
                      durationSeconds={currentFit?.probe.durationSeconds}
                      onChange={(next) =>
                        setTargets((prev) =>
                          prev.map((t) => (t.accountId === a.id ? { ...t, options: { platform: "tiktok", tiktok: next } } : t)),
                        )
                      }
                      onConsentChange={(next) => setConsents((prev) => ({ ...prev, [a.id]: next }))}
                      onInfo={(info) => {
                        setCreatorInfo((prev) => (prev[a.id] === info ? prev : { ...prev, [a.id]: info }));
                        // Only what the platform offered: the three
                        // interaction switches take TikTok's own defaults
                        // (once — never over a choice already made), and a
                        // level it no longer offers is replaced by its first.
                        const seedInteractions = !interactionsSeeded.current.has(a.id);
                        interactionsSeeded.current.add(a.id);
                        setTargets((prev) => {
                          let changed = false;
                          const next = prev.map((t) => {
                            if (t.accountId !== a.id || t.options.platform !== "tiktok") return t;
                            const options = seedFromCreatorInfo(t.options, info, seedInteractions);
                            if (options === t.options) return t;
                            changed = true;
                            return { ...t, options };
                          });
                          // Same array back when nothing changed: a fresh one
                          // every time is a re-render every time.
                          return changed ? next : prev;
                        });
                      }}
                    />
                  )}
                </div>
              );
            })}
            <AgentOnlyTargets accounts={agentOnly} />
          </div>
        )}

        {step === "caption" && (
          <CaptionStep
            caption={caption}
            targets={targets}
            pieceId={intent.pieceId}
            pieceName={intent.pieceName}
            onChange={setCaption}
          />
        )}

        {step === "when" && <WhenStep when={when} timezone={tz} targets={targets} onChange={setWhen} />}

        {step === "review" && (
          <ReviewStep
            body={body}
            targets={targets}
            when={when}
            accounts={connected}
            uploading={upload.status === "running"}
            uploadPercent={upload.percent}
            uploadError={upload.error}
            submitting={submitting}
            lastError={lastError}
            targetsReady={targetsReady}
            needsConfirmation={needsConfirmation}
            perTargetErrors={perTargetErrors}
            onSubmit={(confirmed) => void submit(confirmed)}
            onRetry={() => void submit()}
          />
        )}

        <div className="flex items-center gap-3 border-t border-border pt-3">
          {step !== "media" && (
            <Button variant="outline" className="cursor-pointer" data-testid="composer-back" onClick={() => setStep(STEPS[STEPS.indexOf(step) - 1])}>
              Back
            </Button>
          )}
          {showNext && (
            <Button className="cursor-pointer" data-testid="composer-next" disabled={!nextEnabled[step]} onClick={advance}>
              Next
            </Button>
          )}
          {step === "targets" && targetsBlockedReason && (
            <span className="text-sm text-muted-foreground" data-testid="targets-blocked-reason">
              {targetsBlockedReason}
            </span>
          )}
          {upload.status === "running" && (
            <span className="text-sm text-muted-foreground" data-testid="composer-upload-progress">
              Uploading {upload.percent}%
            </span>
          )}
          {upload.status === "done" && step !== "review" && <span className="text-sm text-muted-foreground">Media uploaded</span>}
          {upload.error && <span className="text-sm text-destructive">{upload.error}</span>}
        </div>
      </div>
    </div>
  );
}
