import { describe, it, expect } from "vitest";
import { SOCIAL_PROVIDER_CATALOG, findSocialProvider, OAUTH_SCOPES, isSocialProviderId } from "@/lib/social/catalog";
import { SocialError, socialErrorToResponse, isRetryable, type SocialErrorKind } from "@/lib/social/errors";
import { newRequestId, requestIdForLink } from "@/lib/social/request-id";

describe("social catalog", () => {
  it("has Zernio with the verified limits and one write-capable scope set", () => {
    const z = findSocialProvider("zernio");
    expect(z.mcpUrl).toBe("https://mcp.zernio.com/mcp");
    expect([...z.scopes]).toEqual(["accounts:read", "posts:read", "posts:write", "analytics:read"]);
    expect(z.platforms.tiktok.limits.video.maxSeconds).toBe(600);       // creator info on the user's account
    expect(z.platforms.instagram.limits.reel.maxSeconds).toBe(90);
    expect(z.platforms.instagram.limits.story.maxSeconds).toBe(60);
    expect(z.platforms.instagram.limits.story.captionMax).toBe(0);      // stories have no caption
    expect(z.capabilities.ads).toEqual({ readTree: true });
    expect(SOCIAL_PROVIDER_CATALOG.map((p) => p.id)).toEqual(["zernio"]);
    expect(isSocialProviderId("zernio")).toBe(true);
    expect(isSocialProviderId("late")).toBe(false);
    expect(OAUTH_SCOPES.join(" ")).toBe("accounts:read posts:read posts:write analytics:read");
  });
  it("SocialError carries a kind and optional retryAt / perTarget", () => {
    const e = new SocialError("rate_limited", "slow down", { retryAt: "2026-09-20T10:00:00Z", status: 429 });
    expect(e.kind).toBe("rate_limited");
    expect(e.retryAt).toBe("2026-09-20T10:00:00Z");
    expect(e.status).toBe(429);
  });
  it("request ids are UUIDs and unique", () => {
    const a = newRequestId(), b = newRequestId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it("requestIdForLink reuses the link's stored id, and only mints when there is none", () => {
    const reused = requestIdForLink({
      providerId: "zernio", providerPostId: "p1", pieceId: "piece1", exportPath: null,
      requestId: "existing-id", createdBy: "ui", createdAt: new Date(), lastStatus: null, lastStatusAt: null,
    });
    expect(reused).toBe("existing-id");
    expect(requestIdForLink(null)).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdForLink({
      providerId: "zernio", providerPostId: "p1", pieceId: "piece1", exportPath: null,
      requestId: null, createdBy: "ui", createdAt: new Date(), lastStatus: null, lastStatusAt: null,
    })).toMatch(/^[0-9a-f-]{36}$/);
  });

  describe("socialErrorToResponse", () => {
    const cases: Array<{ kind: SocialErrorKind; status: number; retryable: boolean }> = [
      { kind: "unauthorized", status: 401, retryable: false },
      { kind: "rate_limited", status: 429, retryable: true },
      { kind: "not_found", status: 404, retryable: false },
      { kind: "validation", status: 422, retryable: false },
      { kind: "duplicate", status: 409, retryable: false },
      { kind: "partial", status: 207, retryable: false },
      { kind: "provider", status: 502, retryable: true },
      // Structural, not transient: its own status, and NOT retryable — a
      // renamed provider tool must not resend forever as a 502 would.
      { kind: "unsupported", status: 501, retryable: false },
      // Not a failure: the operation was refused pending a human decision.
      { kind: "needs_confirmation", status: 409, retryable: false },
    ];

    it.each(cases)("maps $kind to status $status and reports isRetryable=$retryable", ({ kind, status, retryable }) => {
      const e = new SocialError(kind, "boom");
      const { status: gotStatus, body } = socialErrorToResponse(e);
      expect(gotStatus).toBe(status);
      expect(body.retryAt ?? null).toBe(null);
      expect(body.perTarget ?? []).toEqual([]);
      expect(isRetryable(e, { kind: "read" })).toBe(retryable);
    });

    it("A PUBLISH-NOW WRITE IS NEVER AUTO-RETRYABLE, whatever the error says", () => {
      // The uncovered window: the request reached Zernio, Zernio published, and
      // the answer never came back. From here that is indistinguishable from a
      // request that never arrived, and there is no idempotency header to ask
      // with — so a retry wrapper that trusted the kind alone would post twice.
      for (const kind of ["provider", "rate_limited"] as const) {
        const e = new SocialError(kind, "boom");
        expect(isRetryable(e, { kind: "read" })).toBe(true);
        expect(isRetryable(e, { kind: "write", publishesNow: false })).toBe(true);
        expect(isRetryable(e, { kind: "write", publishesNow: true })).toBe(false);
      }
    });

    it("carries retryAt through for rate_limited and perTarget through for partial", () => {
      const rateLimited = new SocialError("rate_limited", "slow down", { retryAt: "2026-09-20T10:00:00Z" });
      expect(socialErrorToResponse(rateLimited).body.retryAt).toBe("2026-09-20T10:00:00Z");

      const partial = new SocialError("partial", "some targets failed", {
        perTarget: [{ platform: "instagram", accountId: "acc1", error: "rejected" }],
      });
      expect(socialErrorToResponse(partial).body.perTarget).toEqual([{ platform: "instagram", accountId: "acc1", error: "rejected" }]);
    });
  });
});
