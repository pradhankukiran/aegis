import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { SiteNav } from "@/components/landing/SiteNav";
import { Watermark } from "@/components/layout/watermark";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Aegis",
  description:
    "Your decentralized everything-app — pubkey identity, end-to-end encryption, three independent networks. No single adversary can take you off the air.",
};

/**
 * Root layout — owns the page chrome that must appear on every Aegis route.
 *
 * `<SiteNav />` is mounted here so a visitor who lands deep — e.g. on
 * `/herald` from a shared link — can still discover every other feature
 * without backtracking to `/`. The nav is the visual separator above each
 * route's `<PageHeader />` (its bottom border-2 plays the same role
 * `page-header.tsx`'s `border-b` would have, just bolder).
 *
 * `<ThemeProvider>` wires next-themes' `class` strategy. We pin the default
 * to `light` so the bold neobrutalism palette (yellow on cream) renders on
 * first paint without flicker; OS theme detection is disabled so the surface
 * stays predictable for downstream features that key colour on the data
 * rather than the user's environment.
 *
 * `<Watermark />` lives behind the page content (z-0) so any scrolled view
 * — Atlas map, Beacon list, Witness drop — sits on the same diagonal text
 * pattern. `<Toaster />` is portal-mounted at the body root so sonner can
 * stack notifications on top of any route. Both run as siblings inside the
 * ThemeProvider so they inherit the resolved theme class.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
        >
          <SiteNav />
          <Watermark />
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
