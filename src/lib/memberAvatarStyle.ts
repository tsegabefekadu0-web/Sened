/**
 * Which traditional-border frame a member's avatar gets.
 *
 * Deterministic and neutral by construction: the only input is the member's
 * opaque id. It never takes a name (names are not a reliable signal of gender
 * or of anything else) and nothing here infers who a person is. The same id
 * always yields the same frame, on every device and every render, so a member
 * is recognisable from row to row without any stored preference.
 *
 * The four frames are Tibeb (ጥበብ) embroidery borders and are interchangeable:
 * none is "for" anyone. The shawl accents (Gabi, Netela) are different. They
 * are worn only when the member has *chosen* one (`MemberAttire`); no profile
 * field for that exists yet, so today nobody has one and no row shows a shawl.
 * When a profile setting is added it should be passed through as `attire`,
 * and nothing in this file should ever be changed to guess it.
 */

export const TIBEB_FRAMES = ["diamond", "meskel", "zigzag", "weave"] as const;
export type TibebFrame = (typeof TIBEB_FRAMES)[number];

/** Gabi: white cotton shawl. Netela: lighter shawl with a woven border. A member's own choice, never inferred. */
export const MEMBER_ATTIRES = ["gabi", "netela"] as const;
export type MemberAttire = (typeof MEMBER_ATTIRES)[number];

export const DEFAULT_TIBEB_FRAME: TibebFrame = "diamond";

/**
 * FNV-1a, 32 bit, with a murmur3 finaliser. FNV's low bits mix poorly, and the
 * bucket is `hash % 4`, so without the finaliser ids that differ in a few
 * characters pile into one frame. Stable across platforms.
 */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b) >>> 0;
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0;
}

/** The frame for a member id; the neutral default when there is no id. */
export function pickTibebFrame(memberId: string | null | undefined): TibebFrame {
  if (typeof memberId !== "string" || memberId.length === 0) {
    return DEFAULT_TIBEB_FRAME;
  }
  return TIBEB_FRAMES[fnv1a(memberId.toLowerCase()) % TIBEB_FRAMES.length];
}

export function isMemberAttire(value: unknown): value is MemberAttire {
  return typeof value === "string" && (MEMBER_ATTIRES as readonly string[]).includes(value);
}
