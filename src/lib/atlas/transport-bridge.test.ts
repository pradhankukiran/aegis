/**
 * @vitest-environment happy-dom
 *
 * Atlas — transport-bridge tests. Drives a fake AegisTransport whose
 * `subscribeDM` captures the callback, dispatches synthetic IncomingDM
 * envelopes, and asserts that:
 *
 *   - Well-formed `aegis.location` DMs land in the position store.
 *   - Non-location DMs (Herald-style plain text) are skipped silently.
 *   - Malformed envelopes (bad JSON, missing fields, out-of-range coords)
 *     are dropped without throwing.
 *   - `onFix` fires only after the position has been persisted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installFakeIdb, waitForCondition } from "./fake-idb.test-helpers";
import { attachLocationBridge, parseLocationDM } from "./transport-bridge";
import { listFixesForMember, latestForMember } from "./position-store";
import { clearAll } from "./idb";
import {
  LOCATION_MESSAGE_TYPE,
  type LocationMessage,
  type PositionFix,
} from "./types";

import type { AegisTransport, IncomingDM } from "../transport";

const ALICE = "a".repeat(64);

function fix(over: Partial<PositionFix> = {}): PositionFix {
  return {
    lat: 47.6062,
    lon: -122.3321,
    accuracy: 12,
    ts: 1700000000_000,
    ...over,
  };
}

function envelope(over: Partial<PositionFix> = {}): string {
  const msg: LocationMessage = {
    type: LOCATION_MESSAGE_TYPE,
    fix: fix(over),
  };
  return JSON.stringify(msg);
}

function makeDM(over: Partial<IncomingDM> = {}): IncomingDM {
  return {
    id: "dm-" + Math.random().toString(16).slice(2),
    from: ALICE,
    plaintext: envelope(),
    network: "nostr",
    ts: 1700000000,
    ...over,
  };
}

function makeFakeTransport(): {
  transport: AegisTransport;
  fire: (dm: IncomingDM) => void;
  unsub: ReturnType<typeof vi.fn>;
  subscribeDMMock: ReturnType<typeof vi.fn>;
} {
  let captured: ((dm: IncomingDM) => void) | null = null;
  const unsub = vi.fn();
  const subscribeDMMock = vi.fn((cb: (dm: IncomingDM) => void) => {
    captured = cb;
    return unsub;
  });
  const transport = {
    subscribeDM: subscribeDMMock,
  } as unknown as AegisTransport;
  return {
    transport,
    fire: (dm) => {
      if (!captured) throw new Error("subscribeDM was not called");
      captured(dm);
    },
    unsub,
    subscribeDMMock,
  };
}

describe("atlas / parseLocationDM", () => {
  it("returns a fix for a well-formed envelope", () => {
    const dm = makeDM({ plaintext: envelope({ lat: 1, lon: 2 }) });
    const parsed = parseLocationDM(dm);
    expect(parsed).not.toBeNull();
    expect(parsed!.from).toBe(ALICE);
    expect(parsed!.fix.lat).toBe(1);
    expect(parsed!.fix.lon).toBe(2);
  });

  it("returns null on non-JSON plaintext", () => {
    expect(parseLocationDM(makeDM({ plaintext: "hello" }))).toBeNull();
  });

  it("returns null when type is not aegis.location", () => {
    const wrong = JSON.stringify({ type: "aegis.message", fix: fix() });
    expect(parseLocationDM(makeDM({ plaintext: wrong }))).toBeNull();
  });

  it("returns null when fix is missing", () => {
    const noFix = JSON.stringify({ type: LOCATION_MESSAGE_TYPE });
    expect(parseLocationDM(makeDM({ plaintext: noFix }))).toBeNull();
  });

  it("returns null when fix has non-numeric lat", () => {
    const bad = JSON.stringify({
      type: LOCATION_MESSAGE_TYPE,
      fix: { lat: "north", lon: 0, accuracy: 1, ts: 0 },
    });
    expect(parseLocationDM(makeDM({ plaintext: bad }))).toBeNull();
  });

  it("returns null when lat is out of WGS-84 range", () => {
    const out = JSON.stringify({
      type: LOCATION_MESSAGE_TYPE,
      fix: { lat: 95, lon: 0, accuracy: 1, ts: 0 },
    });
    expect(parseLocationDM(makeDM({ plaintext: out }))).toBeNull();
  });

  it("returns null when lon is out of WGS-84 range", () => {
    const out = JSON.stringify({
      type: LOCATION_MESSAGE_TYPE,
      fix: { lat: 0, lon: 200, accuracy: 1, ts: 0 },
    });
    expect(parseLocationDM(makeDM({ plaintext: out }))).toBeNull();
  });

  it("returns null when from is empty", () => {
    expect(parseLocationDM(makeDM({ from: "" }))).toBeNull();
  });
});

describe("atlas / attachLocationBridge", () => {
  let restore: () => void;

  beforeEach(() => {
    restore = installFakeIdb();
  });

  afterEach(async () => {
    try {
      await clearAll();
    } catch {
      /* nothing stored */
    }
    restore();
  });

  it("subscribes via subscribeDM and persists incoming location fixes", async () => {
    const onFix = vi.fn();
    const { transport, fire, subscribeDMMock } = makeFakeTransport();
    attachLocationBridge(transport, onFix);
    expect(subscribeDMMock).toHaveBeenCalledTimes(1);

    fire(
      makeDM({
        from: ALICE,
        plaintext: envelope({ lat: 10, lon: 20, ts: 1700000000_000 }),
      }),
    );

    await waitForCondition(() => onFix.mock.calls.length > 0, 300);

    const fixes = await listFixesForMember(ALICE);
    expect(fixes).toHaveLength(1);
    expect(fixes[0].lat).toBe(10);
    expect(fixes[0].lon).toBe(20);
    expect(fixes[0].from).toBe(ALICE);
  });

  it("does not persist non-location DMs (Herald co-existence)", async () => {
    const onFix = vi.fn();
    const { transport, fire } = makeFakeTransport();
    attachLocationBridge(transport, onFix);
    // A raw Herald chat DM — no envelope, no type, no fix.
    fire(makeDM({ plaintext: "hello, this is a chat message" }));
    // Give the bridge plenty of time to do nothing.
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(onFix).not.toHaveBeenCalled();
    expect(await latestForMember(ALICE)).toBeNull();
  });

  it("invokes onFix only after persistence succeeded", async () => {
    const seenFixes: number[] = [];
    const onFix = vi.fn(async (fix) => {
      // Snapshot the store *at the moment onFix runs*. The persisted row
      // must already be visible to a fresh latestForMember read.
      const latest = await latestForMember(fix.from);
      seenFixes.push(latest?.ts ?? -1);
    });
    const { transport, fire } = makeFakeTransport();
    attachLocationBridge(transport, onFix);
    fire(makeDM({ plaintext: envelope({ ts: 1700000123_000 }) }));
    await waitForCondition(() => seenFixes.length > 0, 300);
    expect(seenFixes[0]).toBe(1700000123_000);
  });

  it("returns the underlying transport unsubscribe handle", () => {
    const { transport, unsub } = makeFakeTransport();
    const teardown = attachLocationBridge(transport);
    teardown();
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("drops malformed envelopes without throwing", async () => {
    const onFix = vi.fn();
    const { transport, fire } = makeFakeTransport();
    attachLocationBridge(transport, onFix);
    fire(makeDM({ plaintext: "{not json" }));
    fire(makeDM({ plaintext: JSON.stringify({ type: "aegis.location" }) }));
    await new Promise<void>((r) => setTimeout(r, 30));
    expect(onFix).not.toHaveBeenCalled();
    expect(await listFixesForMember(ALICE)).toEqual([]);
  });
});
