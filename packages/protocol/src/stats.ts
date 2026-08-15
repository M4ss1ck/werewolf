// Per-viewer lifetime stats shown on the profile screen.

import { z } from "zod";

export interface MeStats {
  /** Finished games the viewer played (spectated games excluded). */
  games: number;
  /** Of those, how many they were still alive in at the end. */
  survived: number;
  /** Of those, how many they ended on the wolves faction. */
  asWolf: number;
}

/** Runtime validation for a viewer's lifetime stats. */
export const MeStatsSchema = z.object({
  games: z.number(),
  survived: z.number(),
  asWolf: z.number(),
});
