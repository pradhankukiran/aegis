import Link from "next/link";

/**
 * SiteNav — compact monospace strip linking to each feature route.
 *
 * Mounted in the root layout (see `src/app/layout.tsx`) so it appears on
 * every route. Each feature page mounts its own `<PageHeader />` directly
 * beneath; the nav's bottom `border-b-2` plays the visual-separator role.
 * `mb-0` is intentional — we want the nav and the page header to butt up
 * against each other with no whitespace gap, so the two double-borders
 * read as a single brutalist divider.
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
  return (
    <nav
      aria-label="Aegis features"
      className="mb-0 border-b-2 border-foreground bg-background"
    >
      <ul className="flex flex-wrap items-stretch divide-x-2 divide-foreground">
        {LINKS.map((link) => (
          <li key={link.href} className="flex-1">
            <Link
              href={link.href}
              className="block px-3 py-2 text-center font-mono text-[11px] font-bold uppercase tracking-widest transition-colors hover:bg-foreground hover:text-background sm:text-xs"
            >
              {link.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
