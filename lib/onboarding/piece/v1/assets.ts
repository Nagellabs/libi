// GENERATED FILE — do not edit by hand.
// Written by scripts/extract-onboarding-piece.ts (npm run onboarding:extract)
// from the media the real `libi-onboarding` piece references.
//
// 21 assets, 14,796,113 bytes total. Each sha256 pins the exact
// bytes published to the bucket: a download that does not hash to this is not
// the demo we shipped, and the build must fail rather than render it.
//
// The piece decides WHICH files ship; it does not decide their bytes.
// 3 of these records describe a STAGED file that differs from the piece's
// original — deliberately replaced before publishing, see
// docs-local/onboarding-v1/reencode-decision.md:
//   clip-hero-orbit-v2.mp4
//   clip-track-demo.mp4
//   clip-water-impact.mp4
// Every other record is the piece's original bytes, byte for byte.
import type { OnboardingAsset } from "../types";

export const ONBOARDING_ASSETS_V1: readonly OnboardingAsset[] = [
  {
    slug: "clip-hero-orbit-v2.mp4",
    kind: "video",
    bytes: 2888852,
    sha256: "f1ea90060c8201d7bc0bfd6f452b42791f7a279135cd8f394b0285c65a53612a",
    contentType: "video/mp4",
  },
  {
    slug: "clip-track-demo.mp4",
    kind: "video",
    bytes: 1213391,
    sha256: "43f72396b375e146ded77b59160d8f187394a2e8236e3066fb026890c8d00f2d",
    contentType: "video/mp4",
  },
  {
    slug: "clip-water-impact.mp4",
    kind: "video",
    bytes: 5991387,
    sha256: "ce117061fb8488ddd5f1e3f86604cd4a553c12fd325a6d6f18d75ddb8a16dacb",
    contentType: "video/mp4",
  },
  {
    slug: "kf-hero-end.png",
    kind: "image",
    bytes: 703003,
    sha256: "e5d5ef848e65e27f3843abe8201d749d2aa21e43bb3428b00637cc726bb42bd3",
    contentType: "image/png",
  },
  {
    slug: "kf-hero-start.png",
    kind: "image",
    bytes: 630588,
    sha256: "d79cddfaebff45779b087eccbaed70cd6ea99edcba9377e00398306c09b5164b",
    contentType: "image/png",
  },
  {
    slug: "kf-water-end.png",
    kind: "image",
    bytes: 1258087,
    sha256: "c5aa07b28ade9645bc2f720d11b9475707cc1e0fe5d832432fc6df7831c68681",
    contentType: "image/png",
  },
  {
    slug: "kf-water-start.png",
    kind: "image",
    bytes: 583195,
    sha256: "336898513cf4a1eed9af865decf2238aaa94beaeb6f0faf043edfe5216c486fb",
    contentType: "image/png",
  },
  {
    slug: "libi-ring-glyph.png",
    kind: "image",
    bytes: 24801,
    sha256: "9a4b2cf6163d8d3bf3685962c3343d98852ce05277aacc16b6bda261b6937c40",
    contentType: "image/png",
  },
  {
    slug: "logo-mark.png",
    kind: "image",
    bytes: 434810,
    sha256: "ab8e5b072ffc597abc356645ab72da1462bc5dccc1b5a981965bca64d1bdd83e",
    contentType: "image/png",
  },
  {
    slug: "music-anthem-12s.mp3",
    kind: "audio",
    bytes: 193142,
    sha256: "bfd051d5b51c4b027963acadf58398fdb6f824a9b9159d30794b82b5b3513407",
    contentType: "audio/mpeg",
  },
  {
    slug: "music-build-28s.mp3",
    kind: "audio",
    bytes: 448515,
    sha256: "a24653b3ec34b3d351240f71b12c14d048d03c3bafe3bc224fd3cb6ca22997c1",
    contentType: "audio/mpeg",
  },
  {
    slug: "sfx-basshit.mp3",
    kind: "audio",
    bytes: 17180,
    sha256: "e81ee33509f2ad8086fe3f33d0ad2fde51a64cc97667c4b8524a608db2629e1f",
    contentType: "audio/mpeg",
  },
  {
    slug: "sfx-clicks.mp3",
    kind: "audio",
    bytes: 65245,
    sha256: "3ce4cd377a94c12ab31ccdcd0613656e442d37d9ee20cac27a9b6e1294467ffc",
    contentType: "audio/mpeg",
  },
  {
    slug: "sfx-riser.mp3",
    kind: "audio",
    bytes: 65245,
    sha256: "60dc9ae519506c1487f8d281449ad36a44f49de58731b90a717789e4aecdb650",
    contentType: "audio/mpeg",
  },
  {
    slug: "sfx-typing.mp3",
    kind: "audio",
    bytes: 65245,
    sha256: "1ae7cc3e02084cf28552d6a647b1598df967ea159592aa6b27038ebc2d82cc8b",
    contentType: "audio/mpeg",
  },
  {
    slug: "vo-1-describe.mp3",
    kind: "audio",
    bytes: 18435,
    sha256: "60662a75b4c9bd54069daa46e775b6bbc55c3e2430ed2b76a89ca0e1a8054301",
    contentType: "audio/mpeg",
  },
  {
    slug: "vo-2-agent.mp3",
    kind: "audio",
    bytes: 36407,
    sha256: "1fa1064468da5cd8bb19a072dccc9ef97289312495eeb5b7ab87085d30aa74ca",
    contentType: "audio/mpeg",
  },
  {
    slug: "vo-3-generates.mp3",
    kind: "audio",
    bytes: 55633,
    sha256: "ad5d38f25c51adab61b8ef20857716f6d60c411dee44655dd3b53913a299c779",
    contentType: "audio/mpeg",
  },
  {
    slug: "vo-4-code.mp3",
    kind: "audio",
    bytes: 40169,
    sha256: "d9b7ea6c7d32f176486cbd27ac64d399bdc4d1ea57edd9c27bdee5fd8ff05abd",
    contentType: "audio/mpeg",
  },
  {
    slug: "vo-5-director.mp3",
    kind: "audio",
    bytes: 22614,
    sha256: "5915b2ca504619fe640d09dc50a85db48383367390735e525c04f082b0f34c4c",
    contentType: "audio/mpeg",
  },
  {
    slug: "vo-6-madein.mp3",
    kind: "audio",
    bytes: 40169,
    sha256: "49cebf780f031f2be37b67fcd51566b3b243e6a13f29380169a6af62c691ec31",
    contentType: "audio/mpeg",
  },
];

const BY_SLUG = new Map<string, OnboardingAsset>(
  ONBOARDING_ASSETS_V1.map((a) => [a.slug, a]),
);

/** Look up one asset by its stable slug. Undefined for anything not published. */
export function assetBySlug(slug: string): OnboardingAsset | undefined {
  return BY_SLUG.get(slug);
}
