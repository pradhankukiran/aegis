import Link from "next/link";
import { ArrowRight, Shield } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

/**
 * Angular shield — pure brutalist polygon, no curves. Same path lives in
 * `src/app/icon.svg` for the favicon so the mark stays consistent across
 * the tab icon and the hero.
 */
function ShieldMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="square"
      strokeLinejoin="miter"
      aria-hidden
      className={className}
    >
      <path d="M12 2 L4 5 L4 12 L12 22 L20 12 L20 5 Z" />
    </svg>
  );
}

/**
 * Hero — top block of `/`. States in one breath what Aegis is, then puts
 * a single blue CTA in front of the visitor.
 *
 * Two-column layout on lg+: the wordmark + tagline + CTA on the left,
 * a compact status-panel Card on the right surfacing the build vitals
 * (version, feature count, transports, test count, identity model).
 *
 * The one-liner is pulled verbatim from §13 of the build plan so the
 * pitch stays consistent across the site, README, and any client-facing
 * material.
 */
export function Hero() {
  return (
    <section className="relative border-b-4 border-foreground bg-background">
      <div className="mx-auto grid w-full max-w-6xl grid-cols-1 gap-10 px-4 py-14 sm:px-6 sm:py-20 lg:grid-cols-[1.4fr_1fr] lg:gap-12 lg:px-12 lg:py-24">
        <div className="flex flex-col items-start gap-7">
          <ShieldMark className="text-foreground size-16 sm:size-20 md:size-24" />

          <span className="bg-main text-main-foreground inline-flex items-center gap-2 border-2 border-foreground px-3 py-1.5 font-mono text-[11px] font-bold uppercase tracking-[0.22em] shadow-shadow sm:text-xs">
            <span aria-hidden className="size-1.5 bg-foreground" />
            decentralized everything-app
          </span>

          <h1 className="font-mono text-6xl font-black uppercase leading-[0.85] tracking-tighter sm:text-7xl md:text-8xl lg:text-9xl">
            AEGIS
          </h1>

          <p className="max-w-2xl text-xl font-medium leading-tight tracking-tight sm:text-2xl md:text-3xl">
            <span className="font-black">Pubkey identity</span>.{" "}
            <span className="font-black">End-to-end encryption</span>.{" "}
            <span className="font-black">Three independent networks.</span>{" "}
            <span className="text-muted-foreground">
              No single adversary can take you off the air.
            </span>
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Button asChild size="lg" className="h-12 px-6 text-base font-bold uppercase tracking-wide">
              <Link href="/herald">
                Launch app
                <ArrowRight className="size-4" strokeWidth={3} />
              </Link>
            </Button>
            <Button asChild size="lg" variant="neutral" className="h-12 px-6 text-base font-bold uppercase tracking-wide">
              <Link href="#features">See the roster</Link>
            </Button>
          </div>
        </div>

        <Card className="gap-0 py-0 lg:self-end">
          <div className="flex items-center justify-between gap-3 border-b-2 border-foreground bg-foreground px-4 py-3 text-background">
            <div className="flex items-center gap-2">
              <Shield className="size-5" strokeWidth={2.5} />
              <p className="font-mono text-xs font-bold uppercase tracking-[0.22em]">
                Build status
              </p>
            </div>
            <span className="bg-main text-main-foreground border-2 border-background px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-widest">
              v0.1
            </span>
          </div>
          <dl className="divide-y-2 divide-foreground">
            <StatRow label="features" value="07" />
            <StatRow label="transports" value="03" />
            <StatRow label="tests passing" value="403 / 403" />
            <StatRow label="identity" value="secp256k1" />
            <StatRow label="encryption" value="olm · nip-44 · ssb" />
          </dl>
        </Card>
      </div>
    </section>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 py-3">
      <dt className="text-muted-foreground font-mono text-[11px] font-bold uppercase tracking-widest">
        {label}
      </dt>
      <dd className="font-mono text-sm font-bold uppercase tracking-wide">
        {value}
      </dd>
    </div>
  );
}
