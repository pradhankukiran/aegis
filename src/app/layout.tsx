import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { SiteNav } from "@/components/landing/SiteNav";

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
 * `<SiteNav />` is mounted here (Phase 6 Wave 6b polish) so a visitor who
 * lands deep — e.g. on `/herald` from a shared link — can still discover
 * every other feature without backtracking to `/`. The nav is the visual
 * separator above each route's `<PageHeader />` (its bottom border-2 plays
 * the same role page-header.tsx's `border-b` would have, just bolder).
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SiteNav />
        {children}
      </body>
    </html>
  );
}
