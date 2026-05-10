"use client";

/**
 * Crucible — Tor onion connection indicator.
 *
 * Two states the UI cares about:
 *
 *   1. `.onion` host       → green badge: "Tor connection detected — extra
 *                            anonymity layer active". Brutalist solid border,
 *                            monospace.
 *   2. clearnet host       → yellow brutalist warning card: "You are NOT on
 *                            Tor. Consider switching to the .onion address
 *                            for source anonymity." Doesn't block submission
 *                            — Tor is a deployment concern; the form must
 *                            remain usable for the portfolio demo.
 *
 * Detection runs via `useTorIndicator()` which reads
 * `window.location.hostname` post-mount. The component renders nothing
 * during SSR / first paint (returns `null` while `onTor` is `null`) so
 * we don't flash a "not on Tor" warning before the client knows the
 * answer. After mount the badge or warning appears.
 */

import { useTorIndicator } from "@/lib/crucible";

export function TorIndicator() {
  const onTor = useTorIndicator();
  if (onTor === null) {
    // SSR / first paint — emit a placeholder element with the same height
    // as the badge so the layout doesn't jank on hydration. Empty content;
    // the border is invisible by virtue of `border-transparent`.
    return (
      <div
        aria-hidden
        className="border-2 border-transparent px-3 py-2 font-mono text-[10px] uppercase tracking-widest"
      >
        {" "}
      </div>
    );
  }

  if (onTor) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="inline-flex items-center gap-2 border-2 border-foreground bg-foreground px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-background shadow-[var(--shadow-brutal)]"
        data-testid="tor-indicator-on"
      >
        <span aria-hidden className="inline-block size-2 bg-background" />
        <span>Tor onion detected — extra anonymity active</span>
      </div>
    );
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-2 border-foreground bg-[var(--brutalist-warning,#facc15)] px-3 py-2 font-mono text-[10px] font-bold uppercase tracking-widest text-foreground shadow-[var(--shadow-brutal)]"
      style={{ backgroundColor: "#facc15" }}
      data-testid="tor-indicator-off"
    >
      <p>
        You are NOT on Tor. For source anonymity, switch to the .onion address.
      </p>
    </div>
  );
}
