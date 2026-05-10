import { Radio, Lock, GitBranch, type LucideIcon } from "lucide-react";

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
 * Each card explains one transport: what it brings to the table and which
 * traffic it carries. The closing tagline reinforces the resilience
 * argument that justifies the three-rail design in the first place.
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
            className="max-w-3xl text-3xl font-black tracking-tighter uppercase sm:text-4xl"
          >
            Three networks. One pubkey. No single point of failure.
          </h2>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {NETWORKS.map((net) => {
            const Icon = net.icon;
            return (
              <article
                key={net.name}
                className="flex h-full flex-col gap-4 border-2 border-foreground bg-background p-4 shadow-[var(--shadow-brutal-lg)] sm:p-5"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="bg-foreground text-background flex size-10 shrink-0 items-center justify-center sm:size-12">
                    <Icon className="size-5 sm:size-6" strokeWidth={2.5} />
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
                  <p className="text-sm font-medium leading-snug">{net.used}</p>
                </div>
              </article>
            );
          })}
        </div>

        <div className="border-2 border-foreground bg-foreground text-background p-5 shadow-[var(--shadow-brutal-lg)] sm:p-6">
          <p className="text-base leading-relaxed sm:text-lg">
            Take down one network — the other two still deliver. Block one
            country — peers in others still gossip.{" "}
            <span className="font-black">
              Same identity, same crypto, three transports.
            </span>
          </p>
        </div>
      </div>
    </section>
  );
}
