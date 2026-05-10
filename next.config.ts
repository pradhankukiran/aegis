import type { NextConfig } from "next";

// Baseline security headers applied to every route.
// TODO: CSP — adding a Content-Security-Policy requires testing every page
// (inline styles, dynamic imports, third-party gateways) and is intentionally
// deferred until that audit is done.
const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  // Magic-link tokens live in the URL — never leak them to other origins.
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  // geolocation=(self) is required by Atlas; other sensors stay denied.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(self)",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
