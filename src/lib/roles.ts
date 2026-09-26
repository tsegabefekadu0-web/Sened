export const APPLICATION_ROLES = ["owner", "treasurer", "member", "admin"] as const;
export type ApplicationRole = (typeof APPLICATION_ROLES)[number];

export interface VerifiedUserLike {
  readonly id: string;
  readonly app_metadata?: Record<string, unknown> | null;
}

export function roleFromUser(user: VerifiedUserLike): ApplicationRole | null {
  const metadata = user.app_metadata ?? {};
  const directRole = typeof metadata.role === "string" ? metadata.role : null;
  const roles = Array.isArray(metadata.roles)
    ? metadata.roles.filter((role): role is string => typeof role === "string")
    : [];
  return (
    [directRole, ...roles].find(
      (role): role is ApplicationRole =>
        role !== null && APPLICATION_ROLES.includes(role as ApplicationRole)
    ) ?? null
  );
}

export function canWriteLedger(user: VerifiedUserLike): boolean {
  const role = roleFromUser(user);
  return role === "owner" || role === "treasurer" || role === "admin";
}
