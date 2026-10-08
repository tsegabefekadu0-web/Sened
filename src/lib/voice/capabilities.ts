import { getAccessToken } from "@/lib/auth/browserClient";
import type { AuthedFetchDeps } from "@/lib/auth/authedFetch";
import { listCycles, readCycle, readContributions, readSession, userIdFromAccessToken } from "@/lib/draw/clientDraw";
import { tallyMember } from "@/lib/draw/contributions";
import type { Locale } from "@/lib/i18n";
import { loadHomeLedger } from "@/lib/ledger/clientHome";
import { readMyGroup } from "@/lib/ledger/clientRead";
import { formatPotBalance } from "@/lib/ledger/homeSummary";

import { requestOpenDigest, requestOpenDraft } from "./assistantBridge";
import { parseContributionUtterance } from "./parser";
import type { ProvisionalContribution } from "./types";

/**
 * What the voice assistant is allowed to do, stated once.
 *
 * Framework-free on purpose: Voxide registers these today (English, Gemini
 * Live), and the Amharic voice lane can call the same list tomorrow. Nothing
 * here imports React or the Voxide SDK; the screen it needs (a navigation, a
 * modal) arrives through {@link CapabilityDeps}.
 *
 * The rules, which `test/voice.capabilities.test.ts` pins:
 *
 *  - READ-ONLY capabilities read what the signed-in person can already see, over
 *    the existing Bearer-authenticated client helpers. A signed-out caller gets
 *    a plain "please sign in" and nothing is requested.
 *  - The ONE draft capability is `dangerous` (the widget asks first) and only
 *    PARSES text into a provisional draft and opens the existing review UI. It
 *    never submits: no ledger write, no `/api/bank-verifications`. The person
 *    finishes with a tap in the screen they can see.
 *  - Verifying a payment, crediting the ledger, payouts, sealing or revealing a
 *    draw, and membership or role changes are NOT capabilities, and must not
 *    become ones. Speech is not evidence of money.
 *  - Handlers return small JSON for the model to say aloud: no tokens, no ids a
 *    person would not already see, nothing about other members.
 */

export type CapabilityParamType = "string" | "number" | "boolean";

export interface CapabilityParam {
  readonly type: CapabilityParamType;
  readonly required?: boolean;
  readonly description?: string;
  readonly enum?: readonly string[];
  /** Personal data: the voice vendor must not store the value. */
  readonly sensitive?: boolean;
}

export interface CapabilityResult {
  /** A short machine word the model can branch on. */
  readonly status: string;
  /** One or two plain English sentences the model can read out. */
  readonly message: string;
  readonly [key: string]: unknown;
}

export interface Capability {
  readonly name: string;
  /** English, for the model. */
  readonly description: string;
  readonly params: Readonly<Record<string, CapabilityParam>>;
  /** The widget asks the person to confirm before the handler runs. */
  readonly dangerous: boolean;
  readonly handler: (args: Record<string, unknown>) => Promise<CapabilityResult>;
}

/** Real screens only; anything else is refused. */
export const NAVIGATION_ALLOWLIST: Readonly<Record<string, string>> = {
  home: "/",
  ledger: "/ledger",
  draw: "/draw",
  governance: "/governance",
  voice: "/voice",
  offline: "/offline",
  "sign-in": "/sign-in",
  join: "/join"
};

/** Things no voice capability may ever do. Checked by name in the tests. */
export const NEVER_EXPOSED_WORDS = [
  "verify",
  "credit",
  "payout",
  "seal",
  "reveal",
  "commit",
  "role",
  "member",
  "submit",
  "record",
  "post"
] as const;

export interface PendingSummary {
  readonly waiting: number;
  readonly blocked: number;
  readonly rejected: number;
  readonly spokenNotes: number;
  readonly oldestPendingAt: string | null;
}

export interface CapabilityDeps {
  /** Bearer token for the existing client helpers; defaults to the browser session. */
  readonly getToken?: () => Promise<string | null>;
  readonly fetchImpl?: typeof fetch;
  /** The active group id (a preference; the server re-checks membership). */
  readonly getActiveGroupId: () => string | null;
  readonly getRoute: () => string;
  readonly getLocale: () => Locale;
  readonly setLocale: (locale: Locale) => void;
  readonly navigate: (path: string) => void;
  /** Reads the on-device queue. Defaults to the Dexie store. */
  readonly readPending?: () => Promise<PendingSummary | null>;
  readonly parse?: (utterance: string) => ProvisionalContribution;
  readonly openDigest?: () => boolean;
  readonly openDraft?: (utterance: string) => boolean;
  /** How long to wait for a screen to mount after navigating. */
  readonly screenDelayMs?: number;
}

const SIGN_IN: CapabilityResult = {
  status: "sign_in_required",
  message: "The person is not signed in. Ask them to sign in from the Sign in page, then try again."
};

const UNAVAILABLE: CapabilityResult = {
  status: "unavailable",
  message: "Sened could not read that right now. It may be offline. Try again in a moment."
};

const MAX_UTTERANCE_CHARS = 600;
const AMHARIC_VOICE_HINT =
  "Amharic voice is available through the Amharic voice button in the app, which is the microphone at the bottom of the home screen.";

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function defaultReadPending(): Promise<PendingSummary | null> {
  const { getSenedDatabase, isOfflineStorageAvailable } = await import("@/lib/db");
  if (!isOfflineStorageAvailable()) return null;
  const { summarizeQueue } = await import("@/lib/db/outbox");
  const db = getSenedDatabase();
  const summary = await summarizeQueue(db);
  const spokenNotes = await db.spokenNotes.count();
  return {
    waiting: summary.byState.queued + summary.byState["retry-scheduled"] + summary.byState["in-flight"],
    blocked: summary.blockedCount,
    rejected: summary.rejectedCount,
    spokenNotes,
    oldestPendingAt: summary.oldestPendingAt
  };
}

export function createCapabilities(deps: CapabilityDeps): readonly Capability[] {
  const authDeps: AuthedFetchDeps = {
    getToken: deps.getToken ?? getAccessToken,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {})
  };
  const parse = deps.parse ?? parseContributionUtterance;
  const openDigest = deps.openDigest ?? requestOpenDigest;
  const openDraft = deps.openDraft ?? requestOpenDraft;
  const screenDelay = deps.screenDelayMs ?? 700;

  /** The signed-in user's id, or null when nobody is signed in. */
  async function signedInUserId(): Promise<string | null> {
    const token = await (authDeps.getToken ?? getAccessToken)();
    if (!token) return null;
    return userIdFromAccessToken(token) ?? "";
  }

  /** Run `show` now on the home screen, or after navigating there. */
  function onHome(show: () => void): void {
    if (deps.getRoute() === "/") {
      show();
      return;
    }
    deps.navigate("/");
    setTimeout(show, screenDelay);
  }

  async function activeCycle(): Promise<
    | { readonly ok: true; readonly groupId: string; readonly cycleId: string; readonly name: string }
    | { readonly ok: false; readonly result: CapabilityResult }
  > {
    const mine = await readMyGroup(authDeps, { groupId: deps.getActiveGroupId() });
    if (mine.status === "unauthorized") return { ok: false, result: SIGN_IN };
    if (mine.status === "no-group") {
      return { ok: false, result: { status: "no_group", message: "The person does not belong to a group yet." } };
    }
    if (mine.status === "choose-group") {
      return {
        ok: false,
        result: {
          status: "choose_group",
          message: "The person is in several groups. Ask them to pick one with the group switcher first."
        }
      };
    }
    if (mine.status !== "ok") return { ok: false, result: UNAVAILABLE };
    const cycles = await listCycles(mine.groupId, authDeps);
    if (!cycles.ok) {
      return { ok: false, result: cycles.status === 401 ? SIGN_IN : UNAVAILABLE };
    }
    const open = [...cycles.data].filter((cycle) => cycle.closedAt === null).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const cycle = open[0];
    if (!cycle) {
      return { ok: false, result: { status: "no_cycle", message: "This group has no running equb cycle right now." } };
    }
    return { ok: true, groupId: mine.groupId, cycleId: cycle.cycleId, name: cycle.name };
  }

  const getContributionStatus: Capability = {
    name: "getContributionStatus",
    description:
      "Read how the signed-in person's contributions stand in the group's current equb cycle: how many rounds are met, flagged as unpaid, or not yet due. Read-only. This reflects the ledger only, never what someone says they paid.",
    params: {},
    dangerous: false,
    handler: async () => {
      const userId = await signedInUserId();
      if (userId === null) return SIGN_IN;
      const cycle = await activeCycle();
      if (!cycle.ok) return cycle.result;
      const view = await readContributions(cycle.cycleId, authDeps);
      if (!view.ok) return view.status === 401 ? SIGN_IN : UNAVAILABLE;
      const me = view.data.members.find((member) => member.memberId === userId);
      if (!me) {
        return { status: "not_in_cycle", message: `You are not listed in the cycle "${cycle.name}".` };
      }
      const tally = tallyMember(me);
      const current = view.data.nextRound === null ? null : me.cells.find((cell) => cell.round === view.data.nextRound);
      return {
        status: "ok",
        cycle: cycle.name,
        contributionAmountEtb: view.data.contributionAmount,
        roundsMet: tally.met,
        roundsFlagged: tally.flagged,
        roundsNotYetDue: tally.notDue,
        currentRound: view.data.nextRound,
        currentRoundStatus: current ? current.status : null,
        message:
          tally.flagged === 0
            ? `In ${cycle.name}, ${tally.met} round(s) are recorded as paid and none are flagged. This comes from the ledger.`
            : `In ${cycle.name}, ${tally.met} round(s) are recorded as paid and ${tally.flagged} are flagged as unpaid. This comes from the ledger.`
      };
    }
  };

  const whoIsNextInDraw: Capability = {
    name: "whoIsNextInDraw",
    description:
      "Read the state of the next equb draw: which round is next, whether sealing is open, and when sealing closes. The winner is random and unknown until the draw is revealed, so this never names one in advance. Read-only.",
    params: {},
    dangerous: false,
    handler: async () => {
      if ((await signedInUserId()) === null) return SIGN_IN;
      const cycle = await activeCycle();
      if (!cycle.ok) return cycle.result;
      const read = await readCycle(cycle.cycleId, authDeps);
      if (!read.ok) return read.status === 401 ? SIGN_IN : UNAVAILABLE;
      const nextRound = read.data.cycle.nextRound;
      if (nextRound === null) {
        return { status: "cycle_complete", cycle: cycle.name, message: `Every round of ${cycle.name} has been drawn.` };
      }
      const live = read.data.draws
        .filter((draw) => draw.round === nextRound && !draw.superseded && draw.state !== "cancelled")
        .sort((a, b) => b.openedAt.localeCompare(a.openedAt))[0];
      if (!live) {
        return {
          status: "not_opened",
          cycle: cycle.name,
          nextRound,
          totalRounds: read.data.cycle.totalRounds,
          message: `Round ${nextRound} of ${read.data.cycle.totalRounds} in ${cycle.name} is next. The draw has not been opened yet. The winner is decided by the draw, not in advance.`
        };
      }
      const session = await readSession(live.drawId, authDeps);
      const sealDeadline = session.ok ? session.data.sealDeadline : null;
      return {
        status: "ok",
        cycle: cycle.name,
        nextRound,
        totalRounds: read.data.cycle.totalRounds,
        drawState: live.state,
        sealsIn: live.sealCount,
        sealingClosesAt: live.state === "sealing" ? sealDeadline : null,
        message: `Round ${nextRound} of ${read.data.cycle.totalRounds} in ${cycle.name} is ${live.state}. ${live.sealCount} member(s) have sealed.${
          live.state === "sealing" && sealDeadline ? ` Sealing can be closed after ${sealDeadline}.` : ""
        } The winner is not known until the reveal.`
      };
    }
  };

  const listPendingItems: Capability = {
    name: "listPendingItems",
    description:
      "Read what is waiting on this device to reach the server: queued offline items and provisional spoken notes. Counts only. Read-only.",
    params: {},
    dangerous: false,
    handler: async () => {
      let pending: PendingSummary | null;
      try {
        pending = await (deps.readPending ?? defaultReadPending)();
      } catch {
        return UNAVAILABLE;
      }
      if (pending === null) {
        return { status: "unavailable", message: "This browser cannot keep offline items, so nothing is waiting here." };
      }
      const total = pending.waiting + pending.spokenNotes;
      return {
        status: "ok",
        ...pending,
        message:
          total === 0 && pending.blocked === 0 && pending.rejected === 0
            ? "Nothing is waiting on this device."
            : `${pending.waiting} item(s) are waiting to sync, ${pending.spokenNotes} spoken note(s) are provisional on this device, ${pending.blocked} are blocked and ${pending.rejected} were rejected. Provisional notes are not recorded in the ledger.`
      };
    }
  };

  const readAudioDigest: Capability = {
    name: "readAudioDigest",
    description:
      "Open the spoken balance sheet (audio digest) on the home screen and tell the person the pot balance. Read-only.",
    params: {},
    dangerous: false,
    handler: async () => {
      let potBalance: string | null = null;
      const userId = await signedInUserId();
      if (userId !== null) {
        const home = await loadHomeLedger(authDeps, { groupId: deps.getActiveGroupId() });
        if (home.status === "ready") potBalance = home.summary.potBalance;
        else if (home.status === "empty") potBalance = "0.00";
      }
      onHome(() => {
        openDigest();
      });
      return {
        status: "ok",
        opened: true,
        potBalanceEtb: potBalance === null ? null : formatPotBalance(potBalance),
        message:
          potBalance === null
            ? "The audio digest is open on the home screen. The balance could not be read, so it will say so rather than guess."
            : `The audio digest is open on the home screen. The pot balance is ${formatPotBalance(potBalance)} birr, from the ledger.`
      };
    }
  };

  const navigateTo: Capability = {
    name: "navigateTo",
    description: `Open one of the app's screens. Allowed screens: ${Object.keys(NAVIGATION_ALLOWLIST).join(", ")}.`,
    params: {
      screen: {
        type: "string",
        required: true,
        enum: Object.keys(NAVIGATION_ALLOWLIST),
        description: "The screen to open."
      }
    },
    dangerous: false,
    handler: async (args) => {
      const raw = text(args.screen).toLowerCase().replace(/^\/+/, "");
      // A bare "/" is the home screen; a missing or empty screen is not a request.
      const key = text(args.screen) === "/" ? "home" : raw;
      const path = Object.prototype.hasOwnProperty.call(NAVIGATION_ALLOWLIST, key) ? NAVIGATION_ALLOWLIST[key] : undefined;
      if (path === undefined) {
        return {
          status: "rejected",
          message: `That is not a screen in Sened. Available screens: ${Object.keys(NAVIGATION_ALLOWLIST).join(", ")}.`
        };
      }
      deps.navigate(path);
      return { status: "ok", opened: key, message: `Opened the ${key} screen.` };
    }
  };

  const switchLanguage: Capability = {
    name: "switchLanguage",
    description:
      "Switch the app's screen language between Amharic (am) and English (en). Use it when the person asks for Amharic or English. This voice assistant answers in English; Amharic speech is handled by the Amharic voice button.",
    params: {
      language: { type: "string", required: true, enum: ["am", "en"], description: "am for Amharic, en for English." }
    },
    dangerous: false,
    handler: async (args) => {
      const language = text(args.language).toLowerCase();
      if (language !== "am" && language !== "en") {
        return { status: "rejected", message: "Only Amharic (am) and English (en) are available." };
      }
      deps.setLocale(language);
      return {
        status: "ok",
        language,
        message:
          language === "am"
            ? `The screens are now in Amharic. ${AMHARIC_VOICE_HINT} Tell the person to use it to speak Amharic.`
            : "The screens are now in English."
      };
    }
  };

  const draftContribution: Capability = {
    name: "draftContribution",
    description:
      "Turn what the person said about a contribution (amount, month, bank or Telebirr, reference) into a PROVISIONAL draft and show it on screen for review. It records nothing and is never verified. Read the draft back and tell the person to check it and tap the confirm button themselves.",
    params: {
      utterance: {
        type: "string",
        required: true,
        sensitive: true,
        description: "The person's own words describing the contribution, such as '5000 birr for Meskerem by Telebirr, reference 9BF42'."
      }
    },
    dangerous: true,
    handler: async (args) => {
      const utterance = text(args.utterance).slice(0, MAX_UTTERANCE_CHARS);
      if (utterance === "") {
        return { status: "needs_input", message: "Ask the person what they paid: the amount, the month and how they paid." };
      }
      const draft = parse(utterance);
      const shown = openDraftOnHome(utterance);
      return {
        status: "draft",
        provisional: true,
        verified: false,
        submitted: false,
        shownOnScreen: shown,
        amountEtb: draft.amountWire,
        month: draft.monthLabel,
        channel: draft.provider ?? (draft.rail === "cash" ? "cash" : null),
        referenceHeard: draft.txRef,
        problems: draft.issues,
        message: `${
          draft.amountWire === null ? "No clear amount was heard." : `Heard ${draft.amountWire} birr${draft.monthLabel ? ` for ${draft.monthLabel}` : ""}.`
        } This is a provisional draft, not recorded and not verified. Tell the person to review it on screen and tap the button themselves.`
      };
    }
  };

  function openDraftOnHome(utterance: string): boolean {
    onHome(() => {
      openDraft(utterance);
    });
    return true;
  }

  return [
    getContributionStatus,
    whoIsNextInDraw,
    listPendingItems,
    readAudioDigest,
    navigateTo,
    switchLanguage,
    draftContribution
  ].map(guard);
}

/** A handler that throws must not leak its message (it could carry a token or a URL). */
function guard(capability: Capability): Capability {
  return {
    ...capability,
    handler: async (args) => {
      try {
        return await capability.handler(args ?? {});
      } catch {
        return UNAVAILABLE;
      }
    }
  };
}
