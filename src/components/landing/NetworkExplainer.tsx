import { Radio, Lock, GitBranch, type LucideIcon } from "lucide-react";

import { Card } from "@/components/ui/card";

type Network = {
  name: string;
  symbol: string;
  icon: LucideIcon;
  blurb: string;
  used: string;
};

/**
 * NetworkExplainer — the "three networks, one identity" section.
 *
 * One big outer brutalist Card holding three inner columns. The closing
 * callout strip flips to bg-main (electric blue) so the resilience
 * argument terminates the section with a visible spot of colour.
 */
const NETWORKS: ReadonlyArray<Network> = [
  {
    name: "Nostr",
    symbol: "01",
    icon: Radio,
    blurb:
      "Permissionless pubkey identity. Cheap WebSocket relay broadcast. Cross-relay redundancy with no central host.",
    used: "Public events, instant reach, censorship resistance.",
  },
  {
    name: "Matrix",
    symbol: "02",
    icon: Lock,
    blurb:
      "Production-grade end-to-end encryption (Olm / Megolm) via the Rust crypto stack. Forward secrecy and post-compromise security.",
    used: "1:1 DMs, group state, room membership.",
  },
  {
    name: "Scuttlebutt",
    symbol: "03",
    icon: GitBranch,
    blurb:
      "Offline-first, append-only, peer-to-peer gossip. No relays required — phones swap feeds directly when they meet.",
    used: "Disaster mode, when networks are blocked or down.",
  },
];

export function NetworkExplainer() {
  return (
    <section
      aria-labelledby="networks-heading"
      className="bg-background"
    >
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-12 sm:px-6 sm:py-16 lg:px-12">
        <div className="flex flex-col gap-3">
          <p className="text-muted-foreground font-mono text-[11px] font-bold uppercase tracking-widest sm:text-xs">
            03 transports
          </p>
          <h2
            id="networks-heading"
            className="max-w-3xl text-3xl font-black tracking-tighter uppercase sm:text-4xl md:text-5xl"
          >
            Three networks. One pubkey. No single point of failure.
          </h2>
        </div>

        <Card className="gap-0 py-0">
          <div className="grid grid-cols-1 divide-y-2 divide-foreground md:grid-cols-3 md:divide-y-0 md:divide-x-2">
            {NETWORKS.map((net) => {
              const Icon = net.icon;
              return (
                <article
                  key={net.name}
                  className="flex flex-col gap-4 p-5 sm:p-6"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="bg-foreground text-background flex size-12 shrink-0 items-center justify-center sm:size-14">
                      <Icon className="size-6 sm:size-7" strokeWidth={2.5} />
                    </div>
                    <span className="text-muted-foreground font-mono text-[11px] font-bold uppercase tracking-widest">
                      {net.symbol} / 03
                    </span>
                  </div>
                  <h3 className="text-2xl font-black tracking-tighter uppercase sm:text-3xl">
                    {net.name}
                  </h3>
                  <p className="text-muted-foreground text-sm leading-relaxed">
                    {net.blurb}
                  </p>
                  <div className="mt-auto border-t-2 border-foreground pt-3">
                    <p className="font-mono text-[11px] font-bold uppercase tracking-widest sm:text-xs">
                      Used for
                    </p>
                    <p className="text-sm font-medium leading-snug">
                      {net.used}
                    </p>
                  </div>
                </article>
              );
            })}
          </div>
        </Card>

        {/* Closing callout: solid blue strip with the resilience tagline. */}
        <Card className="bg-main text-main-foreground gap-0 py-5 px-5 sm:py-6 sm:px-7">
          <p className="text-base leading-relaxed sm:text-lg md:text-xl">
            <span className="font-black uppercase tracking-tight">
              Three transports. One identity.
            </span>{" "}
            Take down one, the other two still deliver. Block one country,
            peers in others still gossip.
          </p>
        </Card>
      </div>
    </section>
  );
}
