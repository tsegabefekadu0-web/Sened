"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchVerification, readCycle, verifyInBrowser } from "@/lib/draw/clientDraw";
import { runDemoDraw } from "@/lib/draw/demoDraw";
import type { DrawMember } from "@/lib/draw/types";
import type { CommunityView } from "./useCommunity";

export interface DrawWinner {
  readonly name: string;
  readonly initial: string;
}

export type DrawView =
  | { readonly status: "loading" }
  | { readonly status: "none" }
  | { readonly status: "error" }
  | {
      readonly status: "ready";
      readonly demo: boolean;
      readonly winner: DrawWinner;
      readonly round: number;
      readonly totalRounds: number;
      readonly pot: number;
      readonly letters: readonly string[];
      readonly drawId: string | null;
    };

/**
 * What the draw screen shows. Signed out: a real commit, reveal and verify run on
 * this device with the draw engine (a labelled demonstration). Signed in: the
 * latest revealed draw of the active cycle, read from the draw API. The treasurer's
 * protocol steps (open, seal, commit, reveal, payout) are not part of this screen.
 */
export function useDrawView(c: CommunityView, replayKey: number) {
  const [view, setView] = useState<DrawView>({ status: "loading" });
  const demoVerified = useRef(false);

  useEffect(() => {
    let active = true;
    if (c.mode === "loading") {
      setView({ status: "loading" });
      return;
    }
    if (c.mode === "sample") {
      const roster: DrawMember[] = c.members.map((m, i) => ({
        memberId: `000${i + 1}4444-4444-8444-844444444444`,
        displayName: m.name,
        status: "active",
        contributionAmount: "5000.00"
      }));
      void runDemoDraw(roster, c.cycle?.round ?? 1, roster.length)
        .then((res) => {
          if (!active) return;
          const idx = roster.findIndex((r) => r.memberId === res.winnerMemberId);
          const w = c.members[Math.max(idx, 0)];
          demoVerified.current = res.verified;
          setView({
            status: "ready",
            demo: true,
            winner: { name: w.name, initial: w.initial },
            round: c.cycle?.round ?? 1,
            totalRounds: c.cycle?.totalRounds ?? roster.length,
            pot: 40000,
            letters: c.members.map((m) => m.initial),
            drawId: null
          });
        })
        .catch(() => active && setView({ status: "error" }));
      return () => {
        active = false;
      };
    }
    if (c.mode !== "live" || !c.cycle) {
      setView({ status: "none" });
      return;
    }
    void readCycle(c.cycle.cycleId)
      .then((res) => {
        if (!active) return;
        if (!res.ok) return setView({ status: "error" });
        const revealed = res.data.draws.filter((d) => d.revealedAt !== null && d.winnerMemberId !== null && !d.superseded).sort((a, b) => b.round - a.round);
        const latest = revealed[0];
        if (!latest) return setView({ status: "none" });
        const w = c.members.find((m) => m.id === latest.winnerMemberId);
        const name = w?.name ?? String(latest.winnerMemberId).slice(0, 6);
        setView({
          status: "ready",
          demo: false,
          winner: { name, initial: w?.initial ?? name.charAt(0).toUpperCase() },
          round: latest.round,
          totalRounds: res.data.cycle.totalRounds,
          pot: Number(res.data.cycle.potAmount),
          letters: c.members.length ? c.members.map((m) => m.initial) : [name.charAt(0)],
          drawId: latest.drawId
        });
      })
      .catch(() => active && setView({ status: "error" }));
    return () => {
      active = false;
    };
    // Re-run the demo on replay; live reads only on community change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.mode, c.cycle?.cycleId, c.members, replayKey]);

  /** Recompute the draw on this device. Resolves true when it checks out. */
  const verify = useCallback(async (): Promise<boolean> => {
    if (view.status !== "ready") return false;
    if (view.demo) return demoVerified.current;
    if (!view.drawId) return false;
    const wire = await fetchVerification(view.drawId);
    if (!wire.ok) return false;
    const check = await verifyInBrowser(wire.data);
    return check.trusted;
  }, [view]);

  return { view, verify };
}
