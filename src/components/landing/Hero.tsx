import { Shield } from "lucide-react";

/**
 * Hero — the top block of `/`. States in one breath what Aegis is.
 *
 * The one-liner is pulled verbatim from §13 of the build plan so the pitch
 * stays consistent across the site, README, and any client-facing material.
 */
export function Hero() {
  return (
    <section className="relative border-b-2 border-foreground bg-background">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-8 px-4 py-12 sm:px-6 sm:py-16 lg:px-12 lg:py-20">
        <div className="flex items-center gap-4 sm:gap-6">
          <div className="bg-foreground text-background flex size-14 shrink-0 items-center justify-center shadow-[var(--shadow-brutal-lg)] sm:size-20">
            <Shield className="size-7 sm:size-10" strokeWidth={2.5} />
          </div>
          <h1 className="text-6xl font-black tracking-tighter uppercase sm:text-7xl md:text-8xl">
            Aegis
          </h1>
        </div>

        <p className="max-w-3xl text-xl font-medium leading-snug tracking-tight sm:text-2xl md:text-3xl">
          Your decentralized everything-app —{" "}
          <span className="font-black">pubkey identity</span>,{" "}
          <span className="font-black">end-to-end encryption</span>, three
          independent networks.{" "}
          <span className="text-muted-foreground">
            No single adversary can take you off the air.
          </span>
        </p>

        <div
          aria-label="Build status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-2 border-foreground bg-background px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-widest shadow-[var(--shadow-brutal)] sm:text-xs"
        >
          <span>v0.1</span>
          <span className="text-muted-foreground">·</span>
          <span>7 features</span>
          <span className="text-muted-foreground">·</span>
          <span>3 transports</span>
          <span className="text-muted-foreground">·</span>
          <span>363 tests</span>
        </div>
      </div>
    </section>
  );
}
