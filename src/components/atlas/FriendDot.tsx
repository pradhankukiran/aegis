"use client";

/**
 * Atlas — single friend marker on the Leaflet map.
 *
 * # Marker icon (brutalist)
 *
 * Instead of the default pastel pin (which also has the asset-resolution
 * problem documented in Map.tsx), we render a custom `L.divIcon` whose
 * HTML is a solid black square containing the truncated pubkey. The
 * shadow uses the same `--shadow-brutal` token as our button system so
 * the marker harmonizes with the panel + page header.
 *
 * The popup body, in monospace, surfaces:
 *   - Nickname (if set) + truncated pubkey
 *   - Last-seen timestamp in ISO-ish HH:MM:SS local-time format
 *   - Accuracy ring in meters
 *
 * Map.tsx imports this lazily-via-react-leaflet, so importing leaflet at
 * module scope here is safe — by the time React renders <FriendDot/>
 * MapContainer has already initialized leaflet on the client.
 */

import L from "leaflet";
import { Marker, Popup } from "react-leaflet";

import { truncatePubkey } from "@/lib/atlas";
import type { CircleMember, ReceivedFix } from "@/lib/atlas";

/**
 * Build a brutalist divIcon for a circle member. The HTML is a small
 * black box with the truncated pubkey inside; the icon is anchored at
 * its bottom-center so the bottom edge points at the actual coordinate
 * (consistent with how pin icons traditionally anchor).
 *
 * Pubkey input forms (Matrix MXID) get formatted
 * differently in `truncatePubkey` (it short-circuits on length ≤ 12);
 * the function falls back gracefully so a non-hex `from` still renders
 * something readable.
 */
function buildIcon(member: CircleMember): L.DivIcon {
  const label = member.nickname?.trim()
    ? escapeHtml(member.nickname.trim())
    : truncatePubkey(member.pubkey);
  // Inline the brutalist tokens directly — Leaflet injects the divIcon
  // HTML into the DOM outside our React tree, and that DOM has limited
  // access to Tailwind utility classes resolved at build time. Tailwind
  // can't see this string at compile time so we use literal CSS.
  // The 2px solid black border + 4px offset shadow matches the panel.
  const html = `
    <div style="
      display:inline-block;
      background:#000;
      color:#fff;
      border:2px solid #000;
      box-shadow:4px 4px 0 0 #000;
      font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
      font-size:10px;
      font-weight:700;
      letter-spacing:0.04em;
      padding:2px 6px;
      white-space:nowrap;
      transform:translate(-50%, -100%);
    ">${label}</div>
  `;
  return L.divIcon({
    html,
    // We've already translate'd inside the HTML; declare a zero iconSize
    // so leaflet doesn't add its own offsetting on top.
    iconSize: [0, 0],
    iconAnchor: [0, 0],
    className: "aegis-atlas-friend-dot",
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Format ts (Unix ms) as `YYYY-MM-DD HH:MM:SS` local time. */
function formatLocal(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

export function FriendDot({
  member,
  fix,
}: {
  member: CircleMember;
  fix: ReceivedFix;
}) {
  const icon = buildIcon(member);
  return (
    <Marker position={[fix.lat, fix.lon]} icon={icon}>
      <Popup>
        <div className="font-mono text-xs">
          <div className="text-[10px] uppercase tracking-widest text-muted-foreground">
            {member.nickname?.trim() ? "alias" : "pubkey"}
          </div>
          <div className="font-bold">
            {member.nickname?.trim() ?? truncatePubkey(member.pubkey)}
          </div>
          {member.nickname?.trim() ? (
            <div className="mt-1 break-all text-[10px] text-muted-foreground">
              {truncatePubkey(member.pubkey)}
            </div>
          ) : null}
          <div className="mt-2 text-[10px] uppercase tracking-widest text-muted-foreground">
            last seen
          </div>
          <div>{formatLocal(fix.ts)}</div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            ±{Math.round(fix.accuracy)} m
          </div>
        </div>
      </Popup>
    </Marker>
  );
}
