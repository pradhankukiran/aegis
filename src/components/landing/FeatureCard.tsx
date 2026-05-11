import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

/**
 * Codename → CSS variable for the per-feature spot accent.
 * Surfaced as a 6px left-edge stripe on the card so the seven-feature
 * roster reads as differentiated at a glance — without breaking the
 * white/black/blue page palette.
 */
const SPOT_VAR: Record<string, string> = {
  HERALD: "var(--spot-herald)",
  SCRIBE: "var(--spot-scribe)",
  ATLAS: "var(--spot-atlas)",
  WITNESS: "var(--spot-witness)",
  BEACON: "var(--spot-beacon)",
  QUORUM: "var(--spot-quorum)",
  CRUCIBLE: "var(--spot-crucible)",
};

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
 * Wraps the shared `<Card>` primitive so theming (border, radius,
 * shadow) is centralised. The 6px spot-colour stripe on the left edge
 * gives each feature visual identity without coloring the whole card —
 * the page remains a white + black + blue brutalist canvas.
 *
 * `asChild` lets the Card render as `<Link>` directly so the whole
 * card is a single click target with native keyboard support.
 */
export function FeatureCard({ feature }: { feature: Feature }) {
  const spot = SPOT_VAR[feature.codename] ?? "var(--main)";
  return (
    <Card
      asChild
      className={cn(
        "group relative h-full gap-3 py-4 pl-5 pr-4 sm:gap-4 sm:py-5 sm:pl-6 sm:pr-5",
        "transition-all hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none",
        "focus-within:translate-x-boxShadowX focus-within:translate-y-boxShadowY focus-within:shadow-none",
      )}
    >
      <Link
        href={feature.href}
        className="flex h-full flex-col justify-between gap-3 focus:outline-none"
      >
        {/* Spot-colour stripe — bleeds out through the parent's negative
            inset because the Card has no padding on this side. */}
        <span
          aria-hidden
          className="absolute inset-y-[-2px] left-[-2px] w-[6px] border-2 border-foreground"
          style={{ background: spot }}
        />
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
    </Card>
  );
}
