"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/**
 * SiteNav — horizontal feature strip linking to each Aegis route.
 *
 * Mounted in the root layout (see `src/app/layout.tsx`) so it appears on
 * every route. Each feature page mounts its own `<PageHeader />` directly
 * beneath; the nav's bottom `border-b-4` plays the visual-separator role
 * and intentionally butts up against the page header.
 *
 * Active route is filled with `bg-main` (electric blue) so a deep visitor
 * always knows where they are in the seven-feature roster. Other links
 * stay white-on-black with a hover swap to inverse.
 *
 * Layout: horizontal on md+, wraps to a stacked grid on narrow screens so
 * the seven codenames stay touch-tappable on phones.
 */
const LINKS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/herald", label: "HERALD" },
  { href: "/scribe", label: "SCRIBE" },
  { href: "/atlas", label: "ATLAS" },
  { href: "/witness", label: "WITNESS" },
  { href: "/beacon", label: "BEACON" },
  { href: "/quorum", label: "QUORUM" },
  { href: "/crucible", label: "CRUCIBLE" },
];

export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Aegis features"
      className="relative z-20 mb-0 border-b-4 border-foreground bg-background"
    >
      <div className="flex flex-wrap items-center justify-between gap-0 sm:flex-nowrap">
        <Link
          href="/"
          aria-label="Aegis home"
          className="flex shrink-0 items-center gap-2 border-r-2 border-foreground bg-foreground px-4 py-3 text-background transition-colors hover:bg-main hover:text-main-foreground sm:px-5"
        >
          <span className="size-2 bg-main" aria-hidden />
          <span className="font-mono text-xs font-bold uppercase tracking-[0.22em] sm:text-sm">
            AEGIS
          </span>
        </Link>
        <ul className="flex w-full flex-wrap items-stretch divide-x-2 divide-foreground">
          {LINKS.map((link) => {
            const active = pathname?.startsWith(link.href) ?? false;
            return (
              <li key={link.href} className="flex-1">
                <Link
                  href={link.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "block border-l-2 border-foreground px-3 py-3 text-center font-mono text-[11px] font-bold uppercase tracking-[0.22em] transition-colors sm:text-xs",
                    active
                      ? "bg-main text-main-foreground"
                      : "bg-background hover:bg-foreground hover:text-background",
                  )}
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
