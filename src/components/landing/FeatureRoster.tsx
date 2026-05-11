import { FeatureCard, type Feature } from "./FeatureCard";

/**
 * FeatureRoster — the brutalist 7-card grid on `/`.
 *
 * Order matches the build plan §3 (Herald → Scribe → Atlas → Witness →
 * Beacon → Quorum → Crucible). One pubkey, one transport, seven surfaces.
 *
 * Grid: 1 col on mobile, 2 on md, 3 on lg, 4 on xl. Seven cards land
 * cleanly in those breakpoints — the last row's half-empty slot is
 * deliberate brutalist gutter.
 */
const FEATURES: ReadonlyArray<Feature> = [
  {
    index: 1,
    codename: "HERALD",
    tagline: "Real-time E2E chat",
    description:
      "Matrix Olm 1:1 + Nostr NIP-44 fallback. Conversations and groups, end-to-end encrypted across every connected network.",
    href: "/herald",
  },
  {
    index: 2,
    codename: "SCRIBE",
    tagline: "Encrypted notes",
    description:
      "Personal and collaborative. SSB feed log for your private notes, Y.js CRDT over Matrix for shared documents.",
    href: "/scribe",
  },
  {
    index: 3,
    codename: "ATLAS",
    tagline: "Live location sharing",
    description:
      "Encrypted position fixes to a chosen circle. SSB peer-mesh takes over when cell signal drops.",
    href: "/atlas",
  },
  {
    index: 4,
    codename: "WITNESS",
    tagline: "Multi-network notary",
    description:
      "SHA-256 hashes Schnorr-signed by your identity key. Anchored on all three networks at once, independently verifiable.",
    href: "/witness",
  },
  {
    index: 5,
    codename: "BEACON",
    tagline: "Dead-man's broadcast",
    description:
      "Pre-encoded message, deadline trigger, timelock-encrypted release. Fans out across every network the instant it fires.",
    href: "/beacon",
  },
  {
    index: 6,
    codename: "QUORUM",
    tagline: "Sealed-ballot voting",
    description:
      "Each ballot timelock-encrypted to the drand close round. Every vote opens at once — no early peeks, no coercion.",
    href: "/quorum",
  },
  {
    index: 7,
    codename: "CRUCIBLE",
    tagline: "Whistleblower drop",
    description:
      "Anonymous source side with a signed-in newsroom dashboard. Tor-aware throughout the source path.",
    href: "/crucible",
  },
];

export function FeatureRoster() {
  return (
    <section
      id="features"
      aria-labelledby="roster-heading"
      className="scroll-mt-24 border-b-4 border-foreground bg-background"
    >
      <div className="mx-auto flex w-full max-w-[88rem] flex-col gap-8 px-4 py-14 sm:px-6 sm:py-20 lg:px-12">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground font-mono text-[11px] font-bold uppercase tracking-widest sm:text-xs">
              07 features · one identity
            </p>
            <h2
              id="roster-heading"
              className="text-3xl font-black tracking-tighter uppercase sm:text-4xl md:text-5xl"
            >
              Seven features.
              <br className="hidden sm:inline" />
              <span className="bg-main text-main-foreground inline-block border-2 border-foreground px-2 py-0.5 sm:px-3">
                One pubkey.
              </span>
            </h2>
          </div>
          <p className="text-muted-foreground font-mono text-[11px] font-bold uppercase tracking-widest sm:text-xs">
            Same crypto · Same transport · Same key
          </p>
        </div>

        {/* 4 above, 3 below centered — bottom row keeps the same card width
            as the top row by constraining its width to 75% - half-gap
            (3 cards + 2 gaps == 75% of 4 cards + 3 gaps). */}
        <div className="flex flex-col gap-5">
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-4">
            {FEATURES.slice(0, 4).map((f) => (
              <FeatureCard key={f.href} feature={f} />
            ))}
          </div>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:mx-auto lg:w-[calc(75%-0.3125rem)] lg:grid-cols-3">
            {FEATURES.slice(4).map((f) => (
              <FeatureCard key={f.href} feature={f} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
