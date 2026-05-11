import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * PageHeader — every feature page's top band.
 *
 * Renders a left-edge spot-color stripe so visitors arriving deep know
 * which feature they're on at a glance. The codename → spot-color
 * mapping is centralised here so call sites only need to declare which
 * feature they belong to.
 */
export type FeatureSpot =
  | "herald"
  | "scribe"
  | "atlas"
  | "witness"
  | "beacon"
  | "quorum"
  | "crucible";

const SPOT_VAR: Record<FeatureSpot, string> = {
  herald: "var(--spot-herald)",
  scribe: "var(--spot-scribe)",
  atlas: "var(--spot-atlas)",
  witness: "var(--spot-witness)",
  beacon: "var(--spot-beacon)",
  quorum: "var(--spot-quorum)",
  crucible: "var(--spot-crucible)",
};

export function PageHeader({
  icon: Icon,
  eyebrow,
  title,
  description,
  spot,
  className,
}: {
  icon?: LucideIcon;
  eyebrow?: string;
  title: string;
  description?: string;
  /** Feature whose spot colour paints the left-edge accent stripe. */
  spot?: FeatureSpot;
  className?: string;
}) {
  const spotColor = spot ? SPOT_VAR[spot] : null;
  return (
    <div
      className={cn(
        "relative border-b-2 border-foreground bg-background",
        className,
      )}
    >
      {spotColor ? (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[10px] border-r-2 border-foreground"
          style={{ background: spotColor }}
        />
      ) : null}
      <div
        className={cn(
          "flex w-full flex-col gap-5 px-4 py-10 sm:px-6 sm:py-12 lg:px-12",
          spotColor && "pl-7 sm:pl-10 lg:pl-16",
        )}
      >
        <div className="flex items-center gap-4">
          {Icon ? (
            <div className="bg-foreground text-background flex size-14 shrink-0 items-center justify-center shadow-shadow sm:size-16">
              <Icon className="size-7 sm:size-8" strokeWidth={2.5} />
            </div>
          ) : null}
          <div className="flex min-w-0 flex-col">
            {eyebrow ? (
              <p className="text-muted-foreground font-mono text-[11px] font-bold uppercase tracking-[0.22em] sm:text-xs">
                {eyebrow}
              </p>
            ) : null}
            <h1 className="text-3xl font-black tracking-tighter uppercase sm:text-4xl md:text-5xl">
              {title}
            </h1>
          </div>
        </div>
        {description ? (
          <p className="text-muted-foreground max-w-2xl text-sm leading-relaxed sm:text-base">
            {description}
          </p>
        ) : null}
      </div>
    </div>
  );
}
