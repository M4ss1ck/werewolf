export class GameLock {
  private queues = new Map<string, Promise<void>>();

  async run<T>(gameId: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.queues.get(gameId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);
    this.queues.set(gameId, queued);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.queues.get(gameId) === queued) this.queues.delete(gameId);
    }
  }
}

export const gameLocks = new GameLock();
