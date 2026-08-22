import type { UserId } from "@werewolf/protocol";
import type { SVGProps } from "react";

export const IDENTITY_PALETTE = [
  "#FF8C84",
  "#F6B44C",
  "#D9D64C",
  "#76D06B",
  "#4FC7B5",
  "#5AB2F2",
  "#B3A9FF",
  "#EF8DD4",
] as const;

const CRESCENT_PATH = "M14.5 6a6 6 0 1 0 3.5 10.8A7 7 0 0 1 14.5 6Z";

export type IdentityParticipant = {
  userId: UserId | string;
  displayName: string;
};

export type IdentityMark = {
  userId: UserId;
  displayName: string;
  color: (typeof IDENTITY_PALETTE)[number];
  slot: number;
  baseSlot: number;
  variant: number;
  baseVariant: number;
  accessibleLabel: string;
};

export type IdentityPoint = { x: number; y: number };

export function fnv1a32(fullUserId: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(fullUserId)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function normalizedCohortKey(displayName: string): string {
  return displayName
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase();
}

export function allocateIdentityMarks(
  participants: readonly IdentityParticipant[],
): Map<string, IdentityMark> {
  const cohorts = new Map<string, IdentityParticipant[]>();
  for (const participant of participants) {
    const key = normalizedCohortKey(participant.displayName);
    const cohort = cohorts.get(key) ?? [];
    cohort.push(participant);
    cohorts.set(key, cohort);
  }

  const marks = new Map<string, IdentityMark>();
  for (const cohort of cohorts.values()) {
    const sorted = [...cohort].sort((left, right) =>
      left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0,
    );
    const usedSlots = new Set<number>();
    const usedVariants = new Set<number>();
    for (const [index, participant] of sorted.entries()) {
      const hash = fnv1a32(participant.userId);
      const baseSlot = hash % IDENTITY_PALETTE.length;
      let slot = baseSlot;
      if (index < IDENTITY_PALETTE.length) {
        for (let offset = 0; offset < IDENTITY_PALETTE.length; offset += 1) {
          const candidate = (baseSlot + offset) % IDENTITY_PALETTE.length;
          if (!usedSlots.has(candidate)) {
            slot = candidate;
            break;
          }
        }
        usedSlots.add(slot);
      }

      const baseVariant = (hash >>> 3) % 56;
      let variant = baseVariant;
      for (let offset = 0; offset < 56; offset += 1) {
        const candidate = (baseVariant + offset) % 56;
        if (!usedVariants.has(candidate)) {
          variant = candidate;
          break;
        }
      }
      usedVariants.add(variant);

      const userId = participant.userId as UserId;
      marks.set(userId, {
        userId,
        displayName: participant.displayName,
        color: IDENTITY_PALETTE[slot]!,
        slot,
        baseSlot,
        variant,
        baseVariant,
        accessibleLabel: `${participant.displayName}, user ${participant.userId}`,
      });
    }
  }
  return marks;
}

function roundPoint(value: number): number {
  return Math.round(value * 100) / 100;
}

export function identityChordPoints(variant: number): { start: IdentityPoint; end: IdentityPoint } {
  const startIndex = ((variant % 8) + 8) % 8;
  const span = 1 + (Math.floor(variant / 8) % 7);
  const point = (index: number): IdentityPoint => {
    const angle = -Math.PI / 2 + (index % 8) * (Math.PI / 4);
    return { x: roundPoint(12 + Math.cos(angle) * 5), y: roundPoint(12 + Math.sin(angle) * 5) };
  };
  return { start: point(startIndex), end: point((startIndex + span) % 8) };
}

export type IdentitySigilProps = Omit<SVGProps<SVGSVGElement>, "children" | "color"> & {
  mark: IdentityMark;
  label?: string;
};

export function IdentitySigil({ mark, label, ...props }: IdentitySigilProps) {
  const points = identityChordPoints(mark.variant);
  const svg = (
    <svg {...props} width={24} height={24} viewBox="0 0 24 24" aria-hidden={true}>
      <circle cx="12" cy="12" r="9" fill="none" stroke={mark.color} strokeWidth="2" />
      <path d={CRESCENT_PATH} fill={mark.color} />
      <line
        x1={points.start.x}
        y1={points.start.y}
        x2={points.end.x}
        y2={points.end.y}
        stroke={mark.color}
        strokeWidth="1"
      />
      <circle cx={points.start.x} cy={points.start.y} r="1" fill={mark.color} />
      <circle cx={points.end.x} cy={points.end.y} r="1" fill={mark.color} />
    </svg>
  );
  return label === undefined ? (
    svg
  ) : (
    <>
      {svg}
      <span className="sr-only">{label}</span>
    </>
  );
}
