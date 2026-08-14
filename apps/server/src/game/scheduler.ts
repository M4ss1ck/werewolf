import type { GameRepository } from "@werewolf/db";
import type { GameId } from "@werewolf/protocol";
import type { GameCoordinator } from "./coordinator.ts";

export type SchedulerClock = () => number;

export class PhaseScheduler {
  private readonly timers = new Map<GameId, ReturnType<typeof setTimeout>>();
  private stopped = true;
  private readonly clock: SchedulerClock;

  constructor(
    private readonly repository: GameRepository,
    private readonly coordinator: GameCoordinator,
    clock: SchedulerClock = Date.now,
  ) {
    this.clock = clock;
  }

  async start() {
    this.stopped = false;
    const [scheduled, running] = await Promise.all([
      this.repository.listScheduledGames(),
      this.repository.listRunningGames(),
    ]);
    for (const game of scheduled) {
      const deadline = game.scheduledAt ?? undefined;
      if (deadline !== undefined && deadline <= this.clock())
        await this.fire(game.id as GameId, true);
      else this.register(game.id as GameId, deadline, true);
    }
    for (const game of running) {
      const deadline = game.phaseEndsAt ?? undefined;
      if (deadline !== undefined && deadline <= this.clock())
        await this.fire(game.id as GameId, false);
      else this.register(game.id as GameId, deadline, false);
    }
  }

  stop() {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  private register(gameId: GameId, deadline: number | undefined, scheduled: boolean) {
    if (this.stopped || deadline === undefined) return;
    const old = this.timers.get(gameId);
    if (old) clearTimeout(old);
    const delay = Math.max(0, deadline - this.clock());
    const timer = setTimeout(() => {
      this.timers.delete(gameId);
      void this.fire(gameId, scheduled);
    }, delay);
    this.timers.set(gameId, timer);
  }

  private async fire(gameId: GameId, scheduled: boolean) {
    if (this.stopped) return;
    try {
      if (scheduled) await this.coordinator.resolveScheduled(gameId);
      else await this.coordinator.resolvePhase(gameId);
    } catch (error) {
      // A stale timer is harmless: the authoritative row may have changed since
      // this timer was installed. It will be registered again from that row.
      if (
        !(error instanceof Error) ||
        !["GAME_NOT_STARTED", "GAME_NOT_FOUND"].includes(error.message)
      )
        console.error("phase scheduler transition failed", error);
    }
    if (this.stopped) return;
    const game = await this.repository.getGame(gameId);
    if (!game) return;
    if (game.status === "scheduled") this.register(gameId, game.scheduledAt ?? undefined, true);
    else if (game.status === "running") this.register(gameId, game.phaseEndsAt ?? undefined, false);
  }
}
