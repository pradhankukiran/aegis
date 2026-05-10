import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

export type Feature = {
  /** Index in the canonical roster (1-7). Rendered as a small monospace tag. */
  index: number;
  /** Codename in caps: HERALD, SCRIBE, ATLAS, ... */
  codename: string;
  /** One-line "what it does" — shown directly under the codename. */
  tagline: string;
  /** Short 1-2 sentence description. */
  description: string;
  /** Route the card links to. */
  href: string;
};

/**
 * FeatureCard — single roster entry on the landing page.
 *
 * Each card is a clickable region routed at its dedicated feature page.
 * Brutalist: 2px solid foreground border, 0 radius, hard offset shadow that
 * lifts on hover (translate matches shadow size for the classic "press in"
 * feel familiar from Hermetic's mode cards).
 */
export function FeatureCard({ feature }: { feature: Feature }) {
  return (
    <Link
      href={feature.href}
      className="group flex h-full flex-col justify-between gap-4 border-2 border-foreground bg-background p-4 shadow-[var(--shadow-brutal)] transition-transform hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-foreground focus-visible:ring-offset-2 sm:p-5"
    >
      <div className="flex flex-col gap-2">
        <div className="flex items-start justify-between gap-3">
          <span className="text-muted-foreground font-mono text-[11px] font-bold uppercase tracking-widest">
            {String(feature.index).padStart(2, "0")} / 07
          </span>
          <ArrowUpRight
            className="text-foreground size-4 shrink-0 transition-transform group-hover:-translate-y-0.5 group-hover:translate-x-0.5"
            strokeWidth={2.5}
          />
        </div>
        <h3 className="font-mono text-3xl font-black tracking-tighter uppercase leading-none sm:text-4xl">
          {feature.codename}
        </h3>
        <p className="text-sm font-bold uppercase tracking-wide">
          {feature.tagline}
        </p>
      </div>
      <p className="text-muted-foreground text-xs leading-relaxed sm:text-sm">
        {feature.description}
      </p>
    </Link>
  );
}
