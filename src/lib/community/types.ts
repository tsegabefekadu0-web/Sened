export interface CommunityInvite {
  readonly inviteId: string;
  readonly token: string;
  readonly expiresAt: string;
  readonly maxUses: number;
  readonly joinUrl?: string;
}

export interface CreatedCommunity {
  readonly groupId: string;
  readonly tenantId: string;
  readonly name: string;
  readonly kind: "equb" | "iddir";
  readonly amount: number;
  readonly frequency: "monthly" | "weekly";
  readonly members: number;
  readonly role: string;
  readonly invite: CommunityInvite;
}
