// The crash-report DROP mechanism: a Sentry `Transport` wrapper that refuses to
// perform the network request while the user has opted out.
//
// Division of responsibility with lib/sentry/scrub.ts — keep these straight:
//
//   * THIS FILE DROPS.  Every envelope type the SDK produces — error events,
//     transactions, standalone spans, structured logs, release-health sessions,
//     client reports, check-ins — funnels through one function,
//     `Client.sendEnvelope()`, which does `return await this._transport.send(envelope)`
//     (verified: @sentry/core/build/cjs/client.js:406-410; sessions reach it via
//     `sendSession()` at client.js:349-370, standalone spans via
//     `sendSpanEnvelope()` at @sentry/core/build/cjs/tracing/sentrySpan.js:234+326).
//     Wrapping the transport is therefore the ONE chokepoint that covers all of
//     them, and — unlike the `integrations` option it replaces — the gate is
//     evaluated PER ENVELOPE, at send time. So a mid-session opt-out takes
//     effect immediately, with no reload. That matters on an Electron desktop
//     app whose process lifetime is measured in days.
//
//     ONE CAVEAT for whoever adds an integration later: `sendEnvelope` is the
//     only chokepoint for envelopes the SDK sends ITSELF. `Client.on("beforeEnvelope")`
//     listeners see envelopes before that and can forward them out of band —
//     `spotlightIntegration` POSTs a copy to a local Spotlight sidecar, and
//     `browserProfilingIntegration` uses the hook to attach profiles. NEITHER is
//     installed here (both are opt-in, and neither is in the default integration
//     set), so today the claim above holds unconditionally. If you enable either
//     — or anything else registering `beforeEnvelope` — it will NOT be covered by
//     this wrapper and needs its own `shouldSendCrashReports()` check.
//
//   * lib/sentry/scrub.ts REDACTS.  The `beforeSend*` hooks still do all the
//     identity/secret/path scrubbing for the ENABLED state, which this file
//     does nothing about. Neither mechanism substitutes for the other.
//
// This replaced an earlier `integrations`-based gate (dropping the Node `Http`
// integration's `trackIncomingRequestsAsSessions` and the browser's
// `BrowserSession` integration). That approach had two defects this one fixes:
// `integrations` is evaluated ONCE at `Sentry.init`, so a mid-session opt-out
// left already-installed session integrations emitting for the rest of the
// process; and it only covered release-health sessions, leaving browser Web
// Vitals standalone spans (whose span name is a DOM tree path via
// `htmlTreeAsString(entry.target)` —
// @sentry-internal/browser-utils/build/cjs/metrics/inp.js:74) ungated.
//
// Runtime-agnostic on purpose (same constraint as scrub.ts / enabled.ts): no
// `node:*` and no DOM APIs, so it is safe to bundle into the browser and Edge
// runtimes. The runtime-specific transport FACTORY is injected by the caller
// (`Sentry.makeNodeTransport` on the server, `Sentry.makeFetchTransport` in the
// browser) rather than imported here.
import { shouldSendCrashReports } from "./enabled";

/**
 * Structural mirror of @sentry/core's `Transport` interface, which is exactly
 * `{ send(request: Envelope): PromiseLike<TransportMakeRequestResponse>;
 *    flush(timeout?: number): PromiseLike<boolean> }`
 * (verified: @sentry/core/build/types/types/transport.d.ts). There is no
 * `close()` on the interface — client shutdown goes through `flush`.
 *
 * Declared structurally rather than imported because @sentry/nextjs's public
 * `.d.ts` does not re-export `Transport` (same constraint scrub.ts documents
 * for `SpanJSON` / `TransactionEvent`), and reaching into the undeclared
 * `@sentry/core` transitive dependency is worse than a local shape.
 *
 * `send`'s parameter is `never` so that ANY concrete transport (whose `send`
 * takes a real `Envelope`) satisfies the constraint under contravariance.
 */
type TransportLike = {
  send: (envelope: never) => PromiseLike<unknown>;
  flush: (timeout?: number) => PromiseLike<boolean>;
};

/**
 * Wrap a Sentry transport factory so that, per envelope, `send` performs the
 * network request only while `shouldSendCrashReports()` is true.
 *
 * When the gate is closed, `send` resolves with `{}` and never touches the
 * wrapped transport. `{}` is precisely what the SDK's own transport resolves
 * with when it has nothing left to send (`if (filteredEnvelopeItems.length === 0)
 * { return Promise.resolve({}); }` — @sentry/core/build/cjs/transports/base.js:25-28),
 * and what `sendEnvelope` itself returns when the transport is disabled
 * (client.js:414-415). So it reads as a successful empty result: no retry, no
 * rate-limit bookkeeping, no console warning, no dropped-event outcome
 * recorded.
 *
 * `flush` (and any other member the concrete transport exposes) is carried over
 * from the wrapped transport unchanged, so client shutdown/`close()` still
 * works while opted out.
 *
 * @param makeTransport the runtime's default transport factory
 *   (`Sentry.makeNodeTransport` / `Sentry.makeFetchTransport`)
 */
export function gateTransport<TOptions, TTransport extends TransportLike>(
  makeTransport: (options: TOptions) => TTransport,
): (options: TOptions) => TTransport {
  return (options: TOptions): TTransport => {
    const inner = makeTransport(options);

    const send = (envelope: Parameters<TTransport["send"]>[0]) =>
      shouldSendCrashReports() ? inner.send(envelope) : Promise.resolve({});

    // Spread-then-override rather than a hand-written object, so `flush` and
    // anything else the concrete transport adds keeps delegating. Safe against
    // `this`-binding loss: the SDK's transports are closures over local state,
    // not classes (`createTransport` returns `{ send, flush }` —
    // @sentry/core/build/cjs/transports/base.js:70-73).
    //
    // The cast is unavoidable: TypeScript cannot prove a spread of a generic
    // `TTransport` with one property replaced is still assignable to
    // `TTransport`. The replacement's shape is checked against
    // `TransportLike["send"]` by the constraint, which is the part that matters.
    return { ...inner, send } as unknown as TTransport;
  };
}
