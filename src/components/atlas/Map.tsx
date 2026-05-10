"use client";

/**
 * Atlas — Leaflet map shell.
 *
 * # SSR strategy
 *
 * Leaflet touches `window` at import time (it builds an `L.DomUtil` cache
 * that references the global). Importing `react-leaflet` server-side
 * therefore crashes Next.js' SSR pass. We have two ways to gate this:
 *
 *   1. Wrap this component with `next/dynamic({ssr: false})` at the page.
 *   2. Mark the file `"use client"` and defer the `react-leaflet` import to
 *      `useEffect` so it only runs in the browser.
 *
 * We pick approach #2 here (with the page also dynamically importing this
 * module so the leaflet bundle doesn't land in the initial client
 * payload). The combination keeps SSR clean AND prevents the leaflet CSS
 * + JS from blocking first paint. The component renders a placeholder
 * border during the brief moment between mount and the dynamic import
 * resolving.
 *
 * # Marker icon strategy
 *
 * Leaflet's default `Icon.Default` references image URLs (`marker-icon.png`,
 * `marker-shadow.png`) via `_getIconUrl` which assumes Webpack's URL
 * resolution at import time. Under Next.js' Turbopack-or-Webpack hybrid
 * these resolve to broken paths and the markers render as broken-image
 * boxes. We bypass that entirely by using `L.divIcon` per marker — a
 * styled inline-HTML element that needs no image asset. This is also a
 * happier fit for the brutalist aesthetic: a black square with truncated
 * pubkey text inside, no map-pin pastel.
 *
 * The divIcon factory and the markers themselves live in `FriendDot.tsx`;
 * this file owns just the map container + tile layer.
 */

import "leaflet/dist/leaflet.css";

import { useEffect, useState } from "react";

import { FriendDot } from "./FriendDot";

import type { CircleMember, ReceivedFix } from "@/lib/atlas";

/**
 * The set of `react-leaflet` exports we use. We lazy-import them so the
 * leaflet module's window-touching side effects don't fire during SSR.
 */
type LeafletMods = {
  MapContainer: typeof import("react-leaflet").MapContainer;
  TileLayer: typeof import("react-leaflet").TileLayer;
};

/**
 * Default map view: roughly centered on Berlin so the empty state shows
 * a recognizable city tile. Zoom 2 would let the user see "the whole
 * world", which is friendlier when no friends are on the map yet.
 */
const DEFAULT_CENTER: [number, number] = [52.52, 13.405];
const DEFAULT_ZOOM = 11;

export function AtlasMap({
  members,
  fixesByMember,
}: {
  members: CircleMember[];
  fixesByMember: Record<string, ReceivedFix>;
}) {
  // Hold the loaded module set in state. `null` until the dynamic import
  // resolves; we render a placeholder during that brief window.
  const [mods, setMods] = useState<LeafletMods | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const rl = await import("react-leaflet");
      if (cancelled) return;
      setMods({ MapContainer: rl.MapContainer, TileLayer: rl.TileLayer });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Compute marker entries: only members whose pubkey has a stored fix.
  // We render them as children of MapContainer so leaflet's pane lifecycle
  // (mount + unmount) plays nicely with react reconciliation.
  const markerEntries = members
    .map((m) => ({ member: m, fix: fixesByMember[m.pubkey] ?? null }))
    .filter((e): e is { member: CircleMember; fix: ReceivedFix } =>
      e.fix !== null,
    );

  if (!mods) {
    return (
      <div className="relative h-full w-full border-2 border-foreground bg-muted">
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="font-mono text-xs uppercase tracking-widest text-muted-foreground">
            loading map…
          </p>
        </div>
      </div>
    );
  }

  const { MapContainer, TileLayer } = mods;

  return (
    <div className="relative h-full w-full border-2 border-foreground">
      <MapContainer
        center={DEFAULT_CENTER}
        zoom={DEFAULT_ZOOM}
        scrollWheelZoom
        style={{ width: "100%", height: "100%" }}
        // Brutalist neutral attribution tile sourced from OSM
        attributionControl
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {markerEntries.map(({ member, fix }) => (
          <FriendDot key={member.pubkey} member={member} fix={fix} />
        ))}
      </MapContainer>
    </div>
  );
}
