"use client";

/**
 * Large monospace countdown clock. Re-renders every second.
 *
 * The component owns its own ticker so the parent doesn't have to —
 * placing this on a page costs one `setInterval(1000)` per mounted
 * countdown. Cheap and isolated.
 *
 * The label flips at the deadline: `T-` while pending → `T+` once
 * elapsed. Per the brutalist palette, colour stays monochrome — the sign
 * + label do the work.
 */
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { formatCountdown, secondsUntilDeadline } from "@/lib/beacon";
import type { Beacon } from "@/lib/beacon";

export function CountdownTimer({
  beacon,
  className,
}: {
  beacon: Beacon;
  className?: string;
}) {
  // Tick state — value doesn't matter; the increment just forces a
  // re-render so we re-read the clock.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  const remaining = secondsUntilDeadline(beacon);
  const elapsed = remaining < 0;
  const label = elapsed ? "T+" : "T-";

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <span className="text-muted-foreground font-mono text-[10px] uppercase tracking-widest">
        {elapsed ? "elapsed past deadline" : "until deadline"}
      </span>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xs font-bold uppercase tracking-widest">
          {label}
        </span>
        <span className="font-mono text-3xl font-black tabular-nums sm:text-4xl">
          {formatCountdown(Math.abs(remaining))}
        </span>
      </div>
    </div>
  );
}
