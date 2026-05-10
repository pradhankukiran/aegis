/**
 * Aegis landing page (`/`).
 *
 * Three jobs in order:
 *
 *   1. State in one breath what Aegis is (Hero).
 *   2. Surface the seven features as a clickable roster (FeatureRoster).
 *   3. Explain the three-network design that justifies the architecture
 *      (NetworkExplainer).
 *
 * `<SiteNav />` is mounted in the root layout (see `src/app/layout.tsx`) so
 * every route gets the same horizontal feature strip. The landing page
 * itself stays focused on the hero / roster / explainer sequence below.
 *
 * This page is a pure server component — no client hooks, no state, fully
 * static. Build output should report `/` as ○ (static).
 */
import { Hero } from "@/components/landing/Hero";
import { FeatureRoster } from "@/components/landing/FeatureRoster";
import { NetworkExplainer } from "@/components/landing/NetworkExplainer";

export default function LandingPage() {
  return (
    <main className="flex flex-1 flex-col">
      <Hero />
      <FeatureRoster />
      <NetworkExplainer />
    </main>
  );
}
