import { DrawError } from "./errors";
import { deriveTicket } from "./canonical";
import type { DrawHasher, DrawMember, DrawParticipant } from "./types";

/**
 * M4.2 — rotation.
 *
 * In an Equb the pot is paid out in turn, not by lottery. Our draw is the
 * lottery variant, so it has to earn the fairness that rotation gives for free:
 * a member who already took the pot this cycle is excluded from the remaining
 * draws. Without that rule a treasurer could draw the same cousin twice and the
 * scheme would be indistinguishable from theft.
 */

export function activeMembers(members: readonly DrawMember[]): DrawMember[] {
  return members.filter((member) => member.status === "active");
}

export function excludePriorWinners(
  members: readonly DrawMember[],
  priorWinnerIds: readonly string[]
): DrawMember[] {
  if (priorWinnerIds.length === 0) {
    return activeMembers(members);
  }
  const won = new Set(priorWinnerIds);
  return activeMembers(members).filter((member) => !won.has(member.memberId));
}

export function rotationExhausted(
  members: readonly DrawMember[],
  priorWinnerIds: readonly string[]
): boolean {
  return excludePriorWinners(members, priorWinnerIds).length === 0;
}

function assertDistinctMembers(members: readonly DrawMember[]): void {
  const seen = new Set<string>();
  for (const member of members) {
    if (seen.has(member.memberId)) {
      throw new DrawError(
        "INVALID_REQUEST",
        `Roster contains a duplicate member: ${member.memberId}`
      );
    }
    seen.add(member.memberId);
  }
}

/**
 * Two members must never be able to compute two different orders for the same
 * roster, so tickets must be unique. A SHA-256 collision here is not a
 * probability we can reason about — if it ever happens the draw is
 * unreproducible, and an unreproducible draw is worse than no draw. Fail
 * closed.
 */
export function assertDistinctTickets(participants: readonly DrawParticipant[]): void {
  const seen = new Map<string, string>();
  for (const participant of participants) {
    const existing = seen.get(participant.ticket);
    if (existing !== undefined) {
      throw new DrawError(
        "INTEGRITY_FAILURE",
        `Ticket collision between ${existing} and ${participant.memberId}`
      );
    }
    seen.set(participant.ticket, participant.memberId);
  }
}

export async function buildParticipants(
  members: readonly DrawMember[],
  scope: { readonly groupId: string; readonly cycleId: string },
  hasher: DrawHasher
): Promise<DrawParticipant[]> {
  assertDistinctMembers(members);
  if (members.length === 0) {
    throw new DrawError(
      "NO_ELIGIBLE_PARTICIPANTS",
      "No eligible participants remain for this draw"
    );
  }

  const participants = await Promise.all(
    members.map(async (member) => ({
      memberId: member.memberId,
      displayName: member.displayName,
      contributionAmount: member.contributionAmount,
      ticket: await deriveTicket(
        { groupId: scope.groupId, cycleId: scope.cycleId, memberId: member.memberId },
        hasher
      )
    }))
  );

  assertDistinctTickets(participants);
  return participants;
}

export function findParticipant(
  participants: readonly DrawParticipant[],
  memberId: string
): DrawParticipant | undefined {
  return participants.find((participant) => participant.memberId === memberId);
}

export function assertNotPriorWinner(
  memberId: string,
  priorWinnerIds: readonly string[]
): void {
  if (priorWinnerIds.includes(memberId)) {
    throw new DrawError(
      "REPEAT_WINNER",
      `${memberId} has already been drawn this cycle and is excluded from the remaining draws`
    );
  }
}
